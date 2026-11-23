import { db } from "./db";
import { isReadOnly } from "./read-only";

// When each bot last read a group (067_channel_reads.sql), for its own
// person's chat page alone. A bot's read of a group, and a page of what's
// new that held messages from one, note it right after, outside their own
// read-only snapshot, as ackWake does: the newest message the read gave it
// and when, and the newest of its person's messages the read gave it and
// when that went up. A page can skip messages (the newest page of a busy
// group, the digest's window), so only the person's half says a bot was
// given a message. A read that gave nothing newer moves only the time, and
// at most once a minute: it's looked for first, so a quiet re-read takes no
// lock and writes nothing, unless the last note is from before the bot's
// membership in force (it left and came back), which the person's page
// doesn't show, so the first read after it's put back is noted at once.
// Only for a linked bot, since only its person
// sees it. Never fails the read: a missed note costs only an older time on
// the person's page.

// Where the reads are: group channel id -> the newest message id the read
// gave the bot there (0 when it gave none, as a group's read with nothing
// new does), and the newest of those from its person (0 when none).
export type ReadNote = Map<number, { upto: number; person: number }>;

const QUIET_MS = 60_000;

type Page = { id?: number; from_your_person?: boolean };

// The note for one group from the messages a read gave the bot.
export function noteFor(messages: readonly Page[]): {
  upto: number;
  person: number;
} {
  let upto = 0;
  let person = 0;
  for (const m of messages) {
    const id = m.id ?? 0;
    upto = Math.max(upto, id);
    if (m.from_your_person === true) person = Math.max(person, id);
  }
  return { upto, person };
}

export async function noteReads(botId: number, reads: ReadNote): Promise<void> {
  if (isReadOnly() || reads.size === 0) return;
  try {
    const sql = db();
    // In channel order, so two reads of one bot's groups at once take
    // their rows in the same order.
    const order = [...reads.entries()].sort((a, b) => a[0] - b[0]);
    const [linked] = await sql<{ yes: boolean }[]>`
      SELECT owner_id IS NOT NULL AS yes FROM bots WHERE id = ${botId}`;
    if (!linked?.yes) return;
    const have = await sql<
      {
        channel_id: string;
        read_upto: string;
        person_upto: string;
        quiet: boolean;
      }[]
    >`
      SELECT r.channel_id, r.read_upto, r.person_upto,
        r.read_at >= now() - make_interval(secs => ${QUIET_MS / 1000})
          AND r.read_at >= coalesce(
            (SELECT m.created_at FROM channel_members m
             WHERE m.channel_id = r.channel_id AND m.bot_id = r.bot_id
             ORDER BY m.id DESC LIMIT 1), '-infinity') AS quiet
      FROM channel_reads r
      WHERE r.bot_id = ${botId}
        AND r.channel_id = ANY(${order.map((o) => o[0])}::bigint[])`;
    const known = new Map(have.map((r) => [Number(r.channel_id), r]));
    const due = order.filter(([c, n]) => {
      const r = known.get(c);
      return (
        !r ||
        !r.quiet ||
        n.upto > Number(r.read_upto) ||
        n.person > Number(r.person_upto)
      );
    });
    if (due.length === 0) return;
    await sql`
      INSERT INTO channel_reads AS r
        (channel_id, bot_id, read_upto, read_at, person_upto, person_at)
      SELECT t.c, ${botId}, t.u, now(), t.p,
        CASE WHEN t.p > 0 THEN now() END
      FROM unnest(
          ${due.map((o) => o[0])}::bigint[],
          ${due.map((o) => o[1].upto)}::bigint[],
          ${due.map((o) => o[1].person)}::bigint[])
        AS t(c, u, p)
      WHERE EXISTS (SELECT 1 FROM group_channels g WHERE g.channel_id = t.c)
        AND EXISTS (SELECT 1 FROM bots b
                    WHERE b.id = ${botId} AND b.owner_id IS NOT NULL)
      ON CONFLICT (channel_id, bot_id) DO UPDATE
      SET read_upto = GREATEST(r.read_upto, EXCLUDED.read_upto),
          read_at = GREATEST(r.read_at, EXCLUDED.read_at),
          person_upto = GREATEST(r.person_upto, EXCLUDED.person_upto),
          person_at = CASE WHEN EXCLUDED.person_upto > r.person_upto
                           THEN GREATEST(r.person_at, EXCLUDED.person_at)
                           ELSE r.person_at END
      WHERE EXCLUDED.read_upto > r.read_upto
         OR EXCLUDED.person_upto > r.person_upto
         OR r.read_at < now() - make_interval(secs => ${QUIET_MS / 1000})
         OR r.read_at < (SELECT m.created_at FROM channel_members m
                         WHERE m.channel_id = r.channel_id AND m.bot_id = r.bot_id
                         ORDER BY m.id DESC LIMIT 1)`;
  } catch (e) {
    console.error(e);
  }
}
