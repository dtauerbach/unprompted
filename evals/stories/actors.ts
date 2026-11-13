// Scripted bots: the cast a story needs around its subject. They use the
// public API like any bot; only their setup (age, owner, test mark) and
// skipping rate limits while seeding touch the local database directly.
import type postgres from "postgres";
import { issueOwnerCode } from "../../src/lib/humans";

export type Actor = { handle: string; key: string; id: number };

let ipN = 0;
const nextIp = () => `10.77.${Math.floor(++ipN / 250)}.${(ipN % 250) + 1}`;

export async function api(
  base: string,
  method: string,
  p: string,
  key?: string,
  body?: unknown,
  // biome-ignore lint/suspicious/noExplicitAny: arbitrary JSON answers
): Promise<{ status: number; json: any }> {
  const r = await fetch(`${base}${p}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-real-ip": "10.99.0.1",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await r.text();
  let json: unknown = t;
  try {
    json = JSON.parse(t);
  } catch {}
  return { status: r.status, json };
}

export async function makeActor(
  base: string,
  sql: postgres.Sql,
  handle: string,
  opts: { claimed?: boolean; agedDays?: number; test?: boolean } = {},
): Promise<Actor> {
  const extra: Record<string, unknown> = {};
  if (opts.claimed) {
    extra.owner_code = (
      await issueOwnerCode(sql, `story-human-${handle}`, null)
    ).code;
  }
  const r = await fetch(`${base}/v1/bots`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": nextIp() },
    body: JSON.stringify({ handle, ...extra }),
  });
  const j = (await r.json()) as { bot?: { handle: string }; api_key?: string };
  if (r.status !== 201 || !j.api_key)
    throw new Error(`register ${handle}: ${r.status} ${JSON.stringify(j)}`);
  const [b] = await sql<
    { id: number }[]
  >`SELECT id FROM bots WHERE handle = ${handle}`;
  if (opts.agedDays)
    await sql`UPDATE bots SET created_at = now() - make_interval(days => ${opts.agedDays}) WHERE id = ${b?.id ?? 0}`;
  if (opts.test)
    await sql`INSERT INTO test_bot_marks (bot_id, is_test) VALUES (${b?.id ?? 0}, true)`;
  return { handle, key: j.api_key, id: b?.id ?? 0 };
}

// Writes as an actor, ignoring rate limits (seeding and scripted turns only).
export async function act(
  base: string,
  sql: postgres.Sql,
  a: Actor,
  method: string,
  p: string,
  body?: unknown,
) {
  for (let i = 0; i < 3; i++) {
    const r = await api(base, method, p, a.key, body);
    if (r.status !== 429) {
      if (r.status >= 400)
        throw new Error(
          `${a.handle} ${method} ${p}: ${r.status} ${JSON.stringify(r.json)}`,
        );
      return r.json;
    }
    await sql`DELETE FROM rate_limits WHERE TRUE`;
    // Bursts (#127, 051_burst_limits.sql) on a site that has them.
    await sql`DELETE FROM rate_bursts WHERE TRUE`.catch(() => {});
  }
  throw new Error(`${a.handle} ${method} ${p}: still limited`);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Resolves at an absolute time, or at once if it's past.
export const until = (t: number) => sleep(Math.max(0, t - Date.now()));
