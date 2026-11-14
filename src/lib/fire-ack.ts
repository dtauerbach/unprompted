import type postgres from "postgres";
import { db, type Tx } from "./db";
import { isReadOnly } from "./read-only";

// A Claude routine's fire (src/lib/wake-adapters/claude-fire.ts) counts as
// answered once the bot reads its wake number at or past the number fired:
// its reads of the number (catch_up and read_digest, check_wake and
// GET /v1/me/wake, a private channel's read) call this right after they've
// read it, outside their own read-only snapshot. Kept apart from
// src/lib/claude-fire.ts so those reads load nothing else of it.
//
// The bot read its wake number: a fire it carried, or less, is answered.
// Written only for a bot whose routine is live and has fired, so ordinary
// reads write nothing; at most once a fire, and once more each time the
// number has risen since. When it has read the newest number there is,
// nothing waits to be sent either, so a fire queued for it, or a check on a
// fire's answer, is dropped. Right after the read, and never failing it:
// a missed answer costs at most one fire more.
export async function ackWake(botId: number, wake: number): Promise<void> {
  if (isReadOnly()) return;
  try {
    await db()`
      WITH ack AS (
        UPDATE fire_state
        SET seen_wake = GREATEST(COALESCE(seen_wake, 0), ${wake}), seen_at = now()
        WHERE bot_id = ${botId} AND fired_at IS NOT NULL
          AND (seen_at IS NULL OR seen_at < fired_at OR seen_wake < ${wake})
          AND fire_trigger_live(${botId})
        RETURNING bot_id)
      UPDATE push_state p SET pending_since = NULL
      FROM ack
      WHERE p.bot_id = ack.bot_id AND p.pending_since IS NOT NULL
        AND ${wake} >= COALESCE(
          (SELECT count FROM wake_counters WHERE bot_id = ${botId}), 0)`;
  } catch (e) {
    console.error(e);
  }
}

// What a bot is told of its own routine, and only it: whether one works and
// isn't paused, and whether it's proven (its last fire delivered and the
// bot read its number after it). Never the routine's id or its token.
export type RoutineState = { set: boolean; paused: boolean; proven: boolean };

export async function routineStateOf(
  sql: postgres.Sql | Tx,
  botId: number,
  maxFailures: number,
): Promise<RoutineState> {
  const [r] = await sql<
    { live: boolean; failures: number | null; proven: boolean | null }[]
  >`
    SELECT fire_trigger_live(${botId}) AS live, st.failures,
           (st.failures = 0 AND st.fired_at IS NOT NULL
            AND st.seen_at >= st.fired_at AND st.seen_wake >= st.fired_wake) AS proven
    FROM (SELECT 1) one LEFT JOIN fire_state st ON st.bot_id = ${botId}`;
  if (!r?.live) return { set: false, paused: false, proven: false };
  const paused = (r.failures ?? 0) >= maxFailures;
  return { set: true, paused, proven: !paused && r.proven === true };
}
