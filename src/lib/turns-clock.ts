import type { Tx } from "./db";
import { logAction } from "./log";

// A gathering's turns (106_gathering_turns.sql, src/lib/turns.ts), as the
// clock moves them on. Apart from src/lib/turns.ts, so src/lib/due.ts
// imports nothing that reads the due list back.

// Moves on every gathering whose turns
// came due by `at`, each under its own row lock and savepoint, so one that
// can't move (hidden or ended meanwhile) never stops the run. Returns how
// many it opened or closed.
export async function writeTurns(
  tx: Tx,
  at: Date,
  max: number,
): Promise<number> {
  const due = await tx<{ gathering_id: string; host: string }[]>`
    SELECT d.gathering_id, g.bot_id AS host
    FROM gathering_turn_due() d JOIN gatherings g ON g.id = d.gathering_id
    WHERE d.due_at <= ${at}::timestamptz + interval '1 millisecond'
    ORDER BY d.gathering_id LIMIT ${max}`;
  let n = 0;
  for (const d of due) {
    try {
      // Skips a gathering whose row another write holds, leaving it to the
      // next run, so one slow write never holds up every fire. The read of
      // what it did and the log line go in the same savepoint, so a failure
      // in either rolls back the move and leaves the run whole.
      const moved = await tx.savepoint(async (sp) => {
        const [row] = await sp`
          SELECT 1 FROM gatherings WHERE id = ${d.gathering_id}
          FOR NO KEY UPDATE SKIP LOCKED`;
        if (!row) return false;
        const [a] = await sp<{ r: string }[]>`
          SELECT gathering_turn_advance(${d.gathering_id}) AS r`;
        const r = a?.r;
        if (r !== "opened" && r !== "closed") return false;
        // The newest turn, and how the newest that ended did: the one this
        // opened after, or the last before the close (an end the clock
        // wrote, expired or lost, included).
        const [info] = await sp<{ seq: number | null; ended: string | null }[]>`
          SELECT
            (SELECT max(seq) FROM gathering_turns
             WHERE gathering_id = ${d.gathering_id}) AS seq,
            (SELECT e.outcome FROM gathering_turns t
             JOIN gathering_turn_ends e ON e.turn_id = t.id
             WHERE t.gathering_id = ${d.gathering_id}
             ORDER BY t.seq DESC LIMIT 1) AS ended`;
        await logAction(sp, {
          action:
            r === "opened" ? "gathering.turns.open" : "gathering.turns.close",
          botId: Number(d.host),
          keyId: null,
          subject: `gathering:${d.gathering_id}`,
          ipHash: null,
          detail: { seq: info?.seq ?? null, ended: info?.ended ?? null },
        });
        return true;
      });
      if (moved) n += 1;
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "turns_advance_failed",
          gathering: d.gathering_id,
          code: (err as { code?: string } | null)?.code ?? null,
        }),
      );
    }
  }
  return n;
}
