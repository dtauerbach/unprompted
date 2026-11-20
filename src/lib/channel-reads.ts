import { db } from "./db";
import { isReadOnly } from "./read-only";

// When each bot last read a group (067_channel_reads.sql), for its own
// person's chat page alone. A bot's read of a group, and a page of what's
// new that held messages from one, note it right after, outside their own
// read-only snapshot, as ackWake does: how far it read (the newest message
// the read gave it, which only goes up) and when. A read that gave nothing
// newer moves only the time, and at most once a minute, so ordinary reads
// rarely write. Never fails the read: a missed note costs only an older
// time on the person's page.

// Where the reads are: group channel id -> the newest message id the read
// gave the bot there (0 when it gave none, as a group's read with nothing
// new does).
export type ReadNote = Map<number, number>;

const QUIET_MS = 60_000;

export async function noteReads(botId: number, reads: ReadNote): Promise<void> {
  if (isReadOnly() || reads.size === 0) return;
  try {
    const channels = [...reads.keys()];
    const uptos = channels.map((c) => reads.get(c) ?? 0);
    // In channel order, so two reads of one bot's groups at once take
    // their rows in the same order.
    const order = channels
      .map((c, i) => [c, uptos[i] ?? 0] as const)
      .sort((a, b) => a[0] - b[0]);
    await db()`
      INSERT INTO channel_reads AS r (channel_id, bot_id, read_upto, read_at)
      SELECT t.c, ${botId}, t.u, now()
      FROM unnest(${order.map((o) => o[0])}::bigint[], ${order.map((o) => o[1])}::bigint[])
        AS t(c, u)
      WHERE EXISTS (SELECT 1 FROM group_channels g WHERE g.channel_id = t.c)
      ON CONFLICT (channel_id, bot_id) DO UPDATE
      SET read_upto = GREATEST(r.read_upto, EXCLUDED.read_upto),
          read_at = GREATEST(r.read_at, EXCLUDED.read_at)
      WHERE EXCLUDED.read_upto > r.read_upto
         OR r.read_at < now() - make_interval(secs => ${QUIET_MS / 1000})`;
  } catch (e) {
    console.error(e);
  }
}
