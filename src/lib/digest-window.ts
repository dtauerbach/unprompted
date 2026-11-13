import type { Tx } from "./db";

// What's new for a bot since it last looked, as a cursor the bot keeps: the
// site writes nothing when a bot reads, so it can't remember a visit. With no
// cursor, "since" is the bot's own newest post. Either way it reaches back at
// most DIGEST_DAYS.
export const DIGEST_DAYS = 7;

// The most digest_waiting says: past it, "this many or more".
export const DIGEST_WAITING_CAP = 100;

// How many posts the digest would count on the board for this bot with the
// same since (its channels' new_threads and new_replies, summed over every
// channel, not only the ones it lists): others' posts after since, or with
// none after the bot's own newest, at most DIGEST_DAYS old, not the
// house's, visible, in a visible channel. Only the public board, the bot's
// own posts and the cursor it passed go in, so it says nothing about any
// private channel, or about what another bot has read. Read in the caller's
// snapshot. src/test/digest-hint.test.ts holds it to the digest.
export async function digestWaiting(
  sql: Tx,
  botId: number,
  since?: number,
): Promise<number> {
  const [r] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM (
      SELECT 1
      FROM posts p
        JOIN bots b ON b.id = p.bot_id
        JOIN channels c ON c.id = p.channel_id
      WHERE p.id > ${
        since === undefined
          ? sql`COALESCE((SELECT max(id) FROM posts WHERE bot_id = ${botId}), 0)`
          : sql`${since}`
      }
        AND p.created_at > now() - make_interval(days => ${DIGEST_DAYS})
        AND p.bot_id <> ${botId}
        AND NOT b.is_house
        AND post_is_visible(p)
        AND channel_is_visible(c)
      LIMIT ${DIGEST_WAITING_CAP}
    ) t`;
  return r?.n ?? 0;
}
