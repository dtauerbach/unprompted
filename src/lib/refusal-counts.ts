import { after } from "next/server";
import type postgres from "postgres";
import { isReadOnly } from "./read-only";

// Refusals counted by day and code (db/migrations/072_refusal_counts.sql),
// so moderators can see which limits and gates actually bite. A refused
// write rolls back, so the count is kept apart: logRefusal() in http.ts
// notes each one here, in memory, and the request's after() work adds what's
// waiting to the table in one statement. A server that stops before then
// loses what it held, which a rough count can bear. Nothing here names a bot,
// a person, an address, a key or what was sent: an HTTP path is kept only as
// the template of the route it matched, or 'other'.

export type Surface = "HTTP" | "MCP" | "ACTION";
type Key = { surface: Surface; what: string; code: string; status: number };
type Noted = {
  method: string;
  path: string;
  code: string;
  status: number;
  n: number;
};

const waiting = new Map<string, Noted>();
let scheduled = false;

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
  // The path is matched to a template when it's written, so only its shape
  // is held here, cut short.
  const cut = path.slice(0, 200);
  const k = `${method}\n${cut}\n${code}\n${status}`;
  const had = waiting.get(k);
  if (had) had.n++;
  else waiting.set(k, { method, path: cut, code, status, n: 1 });
  if (waiting.size > 500) waiting.delete(waiting.keys().next().value as string);
  if (scheduled) return;
  scheduled = true;
  try {
    after(async () => {
      try {
        const { db } = await import("./db");
        await flushRefusals(db());
      } catch (e) {
        console.error(e);
      } finally {
        scheduled = false;
      }
    });
  } catch {
    // Outside a request (tests, scripts): they flush when they choose.
    scheduled = false;
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
  const { OPERATIONS } = await import("./openapi");
  const rows = new Map<string, Key & { n: number }>();
  for (const t of taken) {
    const { surface, what } = countedAs(t.method, t.path, OPERATIONS);
    const k = `${surface}\n${what}\n${t.code}`;
    const had = rows.get(k);
    if (had) had.n += t.n;
    else rows.set(k, { surface, what, code: t.code, status: t.status, n: t.n });
  }
  const list = [...rows.values()];
  const d = (day ?? new Date()).toISOString().slice(0, 10);
  await sql`
    INSERT INTO refusal_counts (day, surface, what, code, status, n)
    SELECT ${d}::date, x.surface, x.what, x.code, x.status, x.n
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
      day: Date;
      surface: Surface;
      what: string;
      code: string;
      status: number;
      n: string;
    }[]
  >`
    SELECT day, surface, what, code, status, n FROM refusal_counts
    WHERE day > current_date - ${days}::int
    ORDER BY day DESC, n DESC, surface, what, code`;
  return rows.map((r) => ({
    day: r.day.toISOString().slice(0, 10),
    surface: r.surface,
    what: r.what,
    code: r.code,
    status: Number(r.status),
    n: Number(r.n),
  }));
}

// For tests: what's noted and not yet written.
export function waitingRefusals(): number {
  let n = 0;
  for (const v of waiting.values()) n += v.n;
  return n;
}
