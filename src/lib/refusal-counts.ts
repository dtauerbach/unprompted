import { after } from "next/server";
import type postgres from "postgres";
import { OPERATIONS } from "./openapi";
import { isReadOnly } from "./read-only";

// Refusals counted by day and code (db/migrations/072_refusal_counts.sql),
// so moderators can see which limits and gates actually bite. A refused
// write rolls back, so the count is kept apart: logRefusal() in http.ts
// notes each one here, in memory, and the request's after() work adds what's
// waiting to the table in one statement. A server that stops before then
// loses what it held, and a write whose answer was lost after it committed
// is written again, which a rough count can bear. Nothing here names a bot,
// a person, an address, a key or what was sent: an HTTP path is matched to
// the template of its route when it's noted, or 'other', so nothing a caller
// chose is held even in memory, and what's waiting is bounded by the routes,
// tools and actions and their codes, not by what callers send.

export type Surface = "HTTP" | "MCP" | "ACTION";
type Noted = {
  surface: Surface;
  what: string;
  code: string;
  status: number;
  n: number;
};

const waiting = new Map<string, Noted>();
// When this process last started writing what's waiting, and when it last
// finished: one write started at a time, and one every FLUSH_GAP_MS, so a
// stream of refused requests (a keyless one costs nothing to send) adds one
// statement every so often per server process, not one each. A write that
// never finished (the platform cut its after() off, or it hung) is taken as
// gone after FLUSH_STALE_MS, as push-kick.ts does with its rounds; nothing
// cancels it, so if it does finish later it may overlap the next one, each
// writing its own batch (nothing is counted twice), and only the newest
// write's end clears the guard (`gen`), so a late one can't let a third in.
export const FLUSH_GAP_MS = 30_000;
const FLUSH_STALE_MS = 60_000;
// The routes, tools and actions times their codes stay far under this; it's
// a backstop, past which a new entry is noted as its surface's 'other'.
const MAX_WAITING = 2000;
const flushing: { since: number | null; last: number | null; gen: number } = {
  since: null,
  last: null,
  gen: 0,
};

const CODE_RE = /^[a-z_]{1,40}$/;
const NAME_RE = /^[A-Za-z_]{1,60}$/;
const TOOL_RE = /^\/(copy\/)?mcp [a-z_/]{1,60}$/;

// What a refusal is counted under: an HTTP path matched to a route template
// (by the API's own description), a tool as `/mcp <tool>`, an action's name.
// Anything else, or anything malformed, is 'other', so no caller can make a
// row of its own choosing.
export function countedAs(
  method: string,
  path: string,
  operations: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
): { surface: Surface; what: string } {
  if (method === "MCP")
    return { surface: "MCP", what: TOOL_RE.test(path) ? path : "other" };
  // A page's own refusal (the connector's approval page) counts as an action.
  if (method === "ACTION" || method === "PAGE")
    return { surface: "ACTION", what: NAME_RE.test(path) ? path : "other" };
  // Only a write method the route itself takes.
  const m = /^(POST|DELETE|PUT|PATCH)$/.test(method) ? method : undefined;
  const t =
    m &&
    Object.keys(operations).find(
      (t) => operations[t]?.[m.toLowerCase()] && templateMatches(t, path),
    );
  return { surface: "HTTP", what: m && t ? `${m} ${t}` : "other" };
}

function templateMatches(template: string, path: string): boolean {
  const a = template.split("/");
  const b = path.split("/");
  if (a.length !== b.length) return false;
  return a.every((s, i) =>
    s.startsWith("{") && s.endsWith("}") ? (b[i] ?? "") !== "" : s === b[i],
  );
}

// Called for every refusal logRefusal() sees, before it decides whether to
// log a line. Our own failures and the kill switch aren't counted.
export function countRefusal(
  method: string,
  path: string,
  status: number,
  code: string,
): void {
  if (code === "internal" || code === "read_only" || isReadOnly()) return;
  if (!CODE_RE.test(code) || status < 400 || status > 599) return;
  if (method === "GET" || method === "HEAD") return;
  const at = countedAs(method, path, OPERATIONS);
  if (
    !waiting.has(keyOf({ ...at, code, status })) &&
    waiting.size >= MAX_WAITING
  )
    at.what = "other";
  note({ ...at, code, status, n: 1 });
  kickRefusals();
}

// One entry per surface, what, code and status. The table's key has no
// status (a code is answered with one status), so its status is the last
// seen: if a code ever came with two, its row keeps the latest written.
function keyOf(k: Omit<Noted, "n">): string {
  return `${k.surface}\n${k.what}\n${k.code}\n${k.status}`;
}

function note(t: Noted): void {
  const k = keyOf(t);
  const had = waiting.get(k);
  if (had) had.n += t.n;
  else waiting.set(k, { ...t });
}

// After the answer has gone, writes what's waiting, unless a write is in
// flight or one finished less than FLUSH_GAP_MS ago. route() calls it after
// every answer too, so what's noted is written by a later request (the
// clock's cron calls one each minute) even if no refusal follows.
export function kickRefusals(
  now: number = Date.now(),
  schedule: (task: () => Promise<void>) => void = after,
): void {
  if (waiting.size === 0 || isReadOnly()) return;
  if (flushing.since !== null && now - flushing.since < FLUSH_STALE_MS) return;
  if (flushing.last !== null && now - flushing.last < FLUSH_GAP_MS) return;
  flushing.since = now;
  const gen = ++flushing.gen;
  try {
    schedule(async () => {
      try {
        const { db } = await import("./db");
        await flushRefusals(db());
      } catch (e) {
        console.error(e);
      } finally {
        if (flushing.gen === gen) flushing.since = null;
        flushing.last = Date.now();
      }
    });
  } catch {
    // Outside a request (tests, scripts): they flush when they choose.
    if (flushing.gen === gen) flushing.since = null;
  }
}

// Adds what's waiting to the table, one statement, and forgets it. Taken
// from the map first, so a refusal noted while it runs waits for the next.
export async function flushRefusals(
  sql: postgres.Sql,
  day?: Date,
): Promise<number> {
  if (waiting.size === 0) return 0;
  const taken = [...waiting.values()];
  waiting.clear();
  const rows = new Map<string, Noted>();
  for (const t of taken) {
    const k = `${t.surface}\n${t.what}\n${t.code}`;
    const had = rows.get(k);
    if (had) had.n += t.n;
    else rows.set(k, { ...t });
  }
  const list = [...rows.values()];
  // The database's day, as the moderators' read takes it, unless a test says.
  const d = day ? day.toISOString().slice(0, 10) : null;
  try {
    await sql`
    INSERT INTO refusal_counts (day, surface, what, code, status, n)
    SELECT coalesce(${d}::date, current_date), x.surface, x.what, x.code, x.status, x.n
    FROM unnest(
      ${sql.array(list.map((r) => r.surface))}::text[],
      ${sql.array(list.map((r) => r.what))}::text[],
      ${sql.array(list.map((r) => r.code))}::text[],
      ${sql.array(list.map((r) => r.status))}::smallint[],
      ${sql.array(list.map((r) => r.n))}::bigint[]
    ) AS x(surface, what, code, status, n)
    ORDER BY x.surface, x.what, x.code
    ON CONFLICT (day, surface, what, code)
    DO UPDATE SET n = refusal_counts.n + EXCLUDED.n, status = EXCLUDED.status`;
  } catch (e) {
    // Put them back for the next write, all of them: what's waiting is
    // bounded by the routes and codes, so there's always room.
    for (const t of taken) note(t);
    throw e;
  }
  return list.reduce((s, r) => s + r.n, 0);
}

export type RefusalCount = {
  day: string;
  surface: Surface;
  what: string;
  code: string;
  status: number;
  n: number;
};

// The moderators' read: the last `days` days, busiest first within a day.
export async function refusalCounts(
  sql: postgres.Sql,
  days: number,
): Promise<RefusalCount[]> {
  const rows = await sql<
    {
      day: string;
      surface: Surface;
      what: string;
      code: string;
      status: number;
      n: string;
    }[]
  >`
    SELECT to_char(day, 'YYYY-MM-DD') AS day, surface, what, code, status, n
    FROM refusal_counts
    WHERE day > current_date - ${days}::int
    ORDER BY day DESC, n DESC, surface, what, code`;
  return rows.map((r) => ({
    day: r.day,
    surface: r.surface,
    what: r.what,
    code: r.code,
    status: Number(r.status),
    n: Number(r.n),
  }));
}

// For tests: forget when this process last wrote.
export function resetRefusalFlush(): void {
  flushing.since = null;
  flushing.last = null;
}

// For tests: forget when the last write finished, keeping any in flight.
export function resetRefusalGap(): void {
  flushing.last = null;
}

// For tests: what's noted and not yet written.
export function waitingRefusals(): number {
  let n = 0;
  for (const v of waiting.values()) n += v.n;
  return n;
}
