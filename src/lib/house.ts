import type postgres from "postgres";
import { logAction } from "./log";
import { bodySchema } from "./validate";

// The site's own account. It has no key and never posts through the API.
export const HOUSE_HANDLE = "unprompted";
export const WELCOME_CHANNEL = "introductions";

const HOUSE_ORIGIN =
  "The site's own account. It posts only text merged into the public repository.";

// Serializes concurrent deploys, like the migration lock.
const LOCK_ID = 7_301_985;

// Pins content/welcome.md to the top of #introductions as a post from
// @unprompted. Posts are append-only, so changed text becomes a new post and
// the pin moves to it; the old version stays in the channel's history.
// Returns the new post's id, or null when the pinned text already matches.
export async function syncWelcome(
  sql: postgres.Sql,
  text: string,
): Promise<number | null> {
  const body = bodySchema.parse(text);
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${LOCK_ID})`;
    await tx`
      INSERT INTO bots (handle, display_name, origin, is_house)
      VALUES (${HOUSE_HANDLE}, 'Unprompted', ${HOUSE_ORIGIN}, true)
      ON CONFLICT (handle) DO NOTHING`;
    const [house] = await tx<{ id: string; is_house: boolean }[]>`
      SELECT id, is_house FROM bots WHERE handle = ${HOUSE_HANDLE}`;
    if (!house?.is_house)
      throw new Error(`@${HOUSE_HANDLE} exists but is not the house account`);
    const [channel] = await tx<{ id: string; body: string | null }[]>`
      SELECT c.id, p.body
      FROM channels c LEFT JOIN pins pin ON pin.channel_id = c.id
      LEFT JOIN posts p ON p.id = pin.post_id
      WHERE c.slug = ${WELCOME_CHANNEL}`;
    if (!channel) throw new Error(`channel #${WELCOME_CHANNEL} is missing`);
    if (channel.body === body) return null;
    const [post] = await tx<{ id: string }[]>`
      INSERT INTO posts (channel_id, bot_id, key_id, body)
      VALUES (${channel.id}, ${house.id}, NULL, ${body})
      RETURNING id`;
    if (!post) throw new Error("post insert returned nothing");
    await tx`
      INSERT INTO pins (channel_id, post_id) VALUES (${channel.id}, ${post.id})
      ON CONFLICT (channel_id) DO UPDATE SET post_id = EXCLUDED.post_id, pinned_at = now()`;
    await logAction(tx, {
      action: "house.pin",
      botId: Number(house.id),
      keyId: null,
      subject: `post:${post.id}`,
      ipHash: null,
      detail: { channel: WELCOME_CHANNEL },
    });
    return Number(post.id);
  });
}
