import postgres from "postgres";
import { LOCAL } from "./client";
import { isThrowaway } from "./throwaway";

const databaseUrl = process.env.EVAL_DATABASE_URL;
export const FAST_EVAL_CLOCK =
  LOCAL &&
  process.env.UNPROMPTED_EVAL_CLOCK === "1" &&
  isThrowaway(databaseUrl);

async function fixture<T>(
  run: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  if (!FAST_EVAL_CLOCK || !databaseUrl)
    throw new Error("A fast eval fixture requires a loopback _test database.");
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    // No server feature is needed to age data; only the test database is
    // writable here. Every append-only guard is restored in the transaction.
    return (await sql.begin(run)) as T;
  } finally {
    await sql.end();
  }
}

export async function gatheringStartsIn(
  id: number,
  seconds: number,
): Promise<number> {
  return fixture(async (tx) => {
    await tx`ALTER TABLE gatherings DISABLE TRIGGER gatherings_append_only`;
    const [g] = await tx<{ milliseconds: string }[]>`
      WITH target AS (
        SELECT date_trunc('milliseconds', clock_timestamp())
          + make_interval(secs => ${seconds}) AS starts_at
      )
      UPDATE gatherings g SET starts_at = t.starts_at,
        created_at = t.starts_at - (g.starts_at - g.created_at)
      FROM target t WHERE g.id = ${id} AND NOT EXISTS (
        SELECT 1 FROM gathering_schedules s WHERE s.gathering_id = g.id)
      RETURNING (extract(epoch FROM g.starts_at) * 1000)::bigint AS milliseconds`;
    await tx`ALTER TABLE gatherings ENABLE TRIGGER gatherings_append_only`;
    if (!g) throw new Error("Fixture cannot age this gathering.");
    return Number(g.milliseconds);
  });
}

export async function sessionStartsIn(
  channel: string,
  seconds: number,
): Promise<void> {
  const id = Number(channel.replace(/^private:/, ""));
  await fixture(async (tx) => {
    await tx`ALTER TABLE channel_sessions DISABLE TRIGGER channel_sessions_append_only`;
    const rows = await tx`
      UPDATE channel_sessions SET first_at = clock_timestamp() + make_interval(secs => ${seconds})
      WHERE id = (SELECT max(id) FROM channel_sessions WHERE channel_id = ${id})
        AND first_at IS NOT NULL RETURNING id`;
    await tx`ALTER TABLE channel_sessions ENABLE TRIGGER channel_sessions_append_only`;
    if (rows.length !== 1)
      throw new Error("Fixture expected one live session.");
  });
}

export async function postComesDue(id: number): Promise<string> {
  return fixture(async (tx) => {
    await tx`ALTER TABLE posts DISABLE TRIGGER posts_append_only`;
    const [p] = await tx<{ back_at: Date }[]>`
      WITH target AS (
        SELECT date_trunc('milliseconds', clock_timestamp()) - interval '2 seconds' AS back_at
      )
      UPDATE posts p SET back_at = t.back_at,
        created_at = t.back_at - (p.back_at - p.created_at)
      FROM target t WHERE p.id = ${id} AND p.back_at IS NOT NULL RETURNING p.back_at`;
    await tx`ALTER TABLE posts ENABLE TRIGGER posts_append_only`;
    if (!p) throw new Error("Fixture expected one post with a return time.");
    return p.back_at.toISOString();
  });
}

async function agePendingPush(
  tx: postgres.TransactionSql,
  handle: string,
  seconds: number,
): Promise<void> {
  await tx`
    UPDATE push_state s SET pending_since = s.pending_since - make_interval(secs => ${seconds}),
      last_sent_at = s.last_sent_at - make_interval(secs => ${seconds})
    FROM bots b WHERE s.bot_id = b.id AND b.handle = ${handle}
      AND s.pending_since IS NOT NULL`;
}

export async function eventGapPasses(
  handle: string,
  seconds: number,
): Promise<void> {
  await fixture(async (tx) => {
    const rows = await tx`
      UPDATE event_sub_state s SET last_sent_at = s.last_sent_at - make_interval(secs => ${seconds})
      FROM bots b WHERE s.bot_id = b.id AND b.handle = ${handle}
        AND s.last_sent_at IS NOT NULL RETURNING s.bot_id`;
    if (rows.length !== 1) throw new Error("Fixture expected an event send.");
    await agePendingPush(tx, handle, seconds);
  });
}

export async function routineTimePasses(
  handle: string,
  seconds: number,
): Promise<void> {
  await fixture(async (tx) => {
    const rows = await tx`
      UPDATE fire_state s SET last_sent_at = s.last_sent_at - make_interval(secs => ${seconds}),
        fired_at = s.fired_at - make_interval(secs => ${seconds}),
        ack_due_at = s.ack_due_at - make_interval(secs => ${seconds}),
        seen_at = s.seen_at - make_interval(secs => ${seconds})
      FROM bots b WHERE s.bot_id = b.id AND b.handle = ${handle}
        AND s.last_sent_at IS NOT NULL RETURNING s.bot_id`;
    if (rows.length !== 1) throw new Error("Fixture expected a routine fire.");
    await agePendingPush(tx, handle, seconds);
  });
}

// A post minute elapsed for these bots; preserve fixed-window counts as
// history and age only their post burst, not hourly or unrelated limits.
export async function postMinutesPass(handles: string[]): Promise<void> {
  await fixture(async (tx) => {
    await tx`
      UPDATE rate_limits r
      SET window_start = (SELECT min(o.window_start) FROM rate_limits o WHERE o.bucket = r.bucket)
        - interval '1 minute'
      FROM bots b WHERE b.handle = ANY(${handles}::text[])
        AND r.bucket IN ('post:min:' || b.id, 'post:prompted:min:' || b.id)
        AND r.window_start = date_trunc('minute', now())`;
    // A mature bot uses the rolling burst instead of post:min. A minute
    // of elapsed time refills it naturally without deleting its row.
    await tx`
      UPDATE rate_bursts r SET full_at = r.full_at - interval '1 minute'
      FROM bots b WHERE b.handle = ANY(${handles}::text[])
        AND r.bucket = 'post:burst:' || b.id AND r.full_at > now()`;
  });
}
