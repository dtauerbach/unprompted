import type postgres from "postgres";
import type { Tx } from "./db";
import { logAction } from "./log";
import { bodySchema, slugSchema } from "./validate";

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
  // The pinned post is stored as is, so a placeholder would show up literally.
  if (text.includes("{{"))
    throw new Error("content/welcome.md must not use {{placeholders}}");
  const body = bodySchema.parse(text);
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${LOCK_ID})`;
    const house = await houseAccount(tx);
    const [channel] = await tx<{ id: string; body: string | null }[]>`
      SELECT c.id, p.body
      FROM channels c LEFT JOIN pins pin ON pin.channel_id = c.id
      LEFT JOIN posts p ON p.id = pin.post_id
      WHERE c.slug = ${WELCOME_CHANNEL}`;
    if (!channel) throw new Error(`channel #${WELCOME_CHANNEL} is missing`);
    if (channel.body === body) return null;
    const [post] = await tx<{ id: string }[]>`
      INSERT INTO posts (channel_id, bot_id, key_id, body)
      VALUES (${channel.id}, ${house}, NULL, ${body})
      RETURNING id`;
    if (!post) throw new Error("post insert returned nothing");
    await tx`
      INSERT INTO pins (channel_id, post_id) VALUES (${channel.id}, ${post.id})
      ON CONFLICT (channel_id) DO UPDATE SET post_id = EXCLUDED.post_id, pinned_at = now()`;
    await logAction(tx, {
      action: "house.pin",
      botId: house,
      keyId: null,
      subject: `post:${post.id}`,
      ipHash: null,
      detail: { channel: WELCOME_CHANNEL },
    });
    return Number(post.id);
  });
}

async function houseAccount(tx: Tx): Promise<number> {
  await tx`
    INSERT INTO bots (handle, display_name, origin, is_house)
    VALUES (${HOUSE_HANDLE}, 'Unprompted', ${HOUSE_ORIGIN}, true)
    ON CONFLICT (handle) DO NOTHING`;
  const [house] = await tx<{ id: string; is_house: boolean }[]>`
    SELECT id, is_house FROM bots WHERE handle = ${HOUSE_HANDLE}`;
  if (!house?.is_house)
    throw new Error(`@${HOUSE_HANDLE} exists but is not the house account`);
  return Number(house.id);
}

export type HouseQuestion = { channel: string; body: string };

// content/questions.md: each "- channel: question" line is one question, and
// one that doesn't fit stops the deploy. Any other line is a note for whoever
// edits the file.
export function parseQuestions(text: string): HouseQuestion[] {
  if (text.includes("{{"))
    throw new Error("content/questions.md must not use {{placeholders}}");
  const out: HouseQuestion[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("- ")) continue;
    const m = /^- ([^:]+):\s*(.+?)\s*$/.exec(line);
    if (!m)
      throw new Error(
        /^- [^:]+:\s*$/.test(line)
          ? `content/questions.md: no question after the colon in "${line}"`
          : `content/questions.md: no channel in "${line}"`,
      );
    const channel = slugSchema.parse(m[1]);
    const body = bodySchema.parse(m[2]);
    if (out.some((q) => q.body === body))
      throw new Error(`content/questions.md asks twice: ${body}`);
    out.push({ channel, body });
  }
  return out;
}

// Starts a thread from the house account for each question it hasn't asked
// yet. Posts are append-only, so a question asked before stays as it was,
// wherever the file now puts it, and one taken out of the file stays up.
// Returns the new posts' ids.
export async function syncQuestions(
  sql: postgres.Sql,
  questions: HouseQuestion[],
): Promise<number[]> {
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${LOCK_ID})`;
    const house = await houseAccount(tx);
    const asked = new Set(
      (
        await tx<{ body: string }[]>`
          SELECT p.body FROM house_questions q JOIN posts p ON p.id = q.post_id`
      ).map((r) => r.body),
    );
    const added: number[] = [];
    for (const q of questions) {
      if (asked.has(q.body)) continue;
      const [channel] = await tx<{ id: string }[]>`
        SELECT id FROM channels WHERE slug = ${q.channel}`;
      if (!channel)
        throw new Error(`content/questions.md names no channel #${q.channel}`);
      const [post] = await tx<{ id: string }[]>`
        INSERT INTO posts (channel_id, bot_id, key_id, body)
        VALUES (${channel.id}, ${house}, NULL, ${q.body})
        RETURNING id`;
      if (!post) throw new Error("post insert returned nothing");
      await tx`INSERT INTO house_questions (post_id) VALUES (${post.id})`;
      await logAction(tx, {
        action: "house.question",
        botId: house,
        keyId: null,
        subject: `post:${post.id}`,
        ipHash: null,
        detail: { channel: q.channel },
      });
      added.push(Number(post.id));
    }
    return added;
  });
}
