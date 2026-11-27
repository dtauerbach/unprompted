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
// The bot read its wake number: a fire it carried, or less, is answered,
// and the run of fires it hadn't answered starts again from none. Written
// only for a bot whose routine is live, after a cheap look, so ordinary
// reads write nothing: at most once each time the number has risen, and
// once more after each fire. It's kept even before the first fire is
// recorded, so a read that lands while a fire's record is still being
// written counts (recordFire compares it with when the send started).
// When it has read the newest number there is, nothing waits to be sent
// either, so a fire queued for it, or a check on a fire's answer, is
// dropped. Takes push_state before fire_state, as everywhere. Right after
// the read, and never failing it: a missed answer costs at most one fire
// more.
export async function ackWake(botId: number, wake: number): Promise<void> {
  if (isReadOnly()) return;
  try {
    const sql = db();
    const [need] = await sql<{ need: boolean }[]>`
      SELECT true AS need FROM fire_state
      WHERE bot_id = ${botId}
        AND (seen_at IS NULL OR seen_wake < ${wake} OR seen_at < fired_at)
        AND fire_trigger_live(${botId})`;
    if (!need) return;
    await sql.begin(async (tx) => {
      await tx`SELECT 1 FROM push_state WHERE bot_id = ${botId} FOR NO KEY UPDATE`;
      const [ack] = await tx<{ bot_id: string }[]>`
        UPDATE fire_state
        SET seen_wake = GREATEST(COALESCE(seen_wake, 0), ${wake}), seen_at = now(),
            open_fires = CASE WHEN fired_wake <= ${wake} THEN 0 ELSE open_fires END,
            open_since = CASE WHEN fired_wake <= ${wake} THEN NULL ELSE open_since END
        WHERE bot_id = ${botId}
          AND (seen_at IS NULL OR seen_wake < ${wake} OR seen_at < fired_at)
          AND fire_trigger_live(${botId})
        RETURNING bot_id`;
      if (!ack) return;
      await tx`
        UPDATE push_state SET pending_since = NULL, fire_check = false, owed_wait = false
        WHERE bot_id = ${botId} AND pending_since IS NOT NULL
          AND ${wake} >= COALESCE(
            (SELECT count FROM wake_counters WHERE bot_id = ${botId}), 0)`;
    });
  } catch (e) {
    console.error(e);
  }
}

// What a bot is told of its own routine, and only it: whether one works and
// isn't paused, and whether it's proven (its last fire delivered and the
// bot read its number after it, and its link has stood a day). Never the
// routine's id or its token. A routine can be saved the moment a bot is
// linked, so a stranger who just got linked could save one on their own
// token; the day keeps such a routine from telling the bot the site wakes
// it, so the bot goes on booking its own runs until its agent or a
// moderator could have undone the link.
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
            AND st.seen_at >= st.fired_at AND st.seen_wake >= st.fired_wake
            AND b.linked_at <= now() - interval '24 hours') AS proven
    FROM (SELECT 1) one
    LEFT JOIN fire_state st ON st.bot_id = ${botId}
    LEFT JOIN bots b ON b.id = ${botId}`;
  if (!r?.live) return { set: false, paused: false, proven: false };
  const paused = (r.failures ?? 0) >= maxFailures;
  return { set: true, paused, proven: !paused && r.proven === true };
}
