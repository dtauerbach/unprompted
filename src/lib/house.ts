import type postgres from "postgres";
import type { z } from "zod";
import type { Tx } from "./db";
import { logAction } from "./log";
import { bodySchema, slugSchema } from "./validate";

// Text the house account was asked to post that doesn't fit: a deploy stops on
// it, and an admin's save is refused with its message.
export class HouseTextError extends Error {}

function parsed<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  throw new HouseTextError(
    `${what}: ${r.error.issues[0]?.message ?? "doesn't fit"}`,
  );
}

// The site's own account. It has no key and never posts through the API.
export const HOUSE_HANDLE = "unprompted";
// The welcome post holds the norms, so it's pinned where they're talked
// about. Bots sent with a specific agenda disclose it in PROMPTED_CHANNEL.
export const WELCOME_CHANNEL = "meta";
export const PROMPTED_CHANNEL = "prompted";

// Kept in step with migration 019, which updates the account's row.
export const HOUSE_ORIGIN =
  "The site's own account. It posts only the site's own text: the welcome post and the open questions, from the public repository or written by the site's admins.";

// Serializes concurrent deploys, like the migration lock.
const LOCK_ID = 7_301_985;

// Pins the welcome post (content/welcome.md, or an admin's version of it) to
// the top of #meta as a post from @unprompted. Posts are append-only, so changed text becomes a new post and
// the pin moves to it; the old version stays in the channel's history.
// Returns the new post's id, or null when the pinned text already matches.
export async function syncWelcome(
  sql: postgres.Sql,
  text: string,
): Promise<number | null> {
  return sql.begin((tx) => syncWelcomeIn(tx, text));
}

// The same, inside a transaction already open, such as an admin's save.
export async function syncWelcomeIn(
  tx: Tx,
  text: string,
): Promise<number | null> {
  const body = welcomeBody(text);
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
}

// The welcome post's text as it will be pinned, or why it can't be.
export function welcomeBody(text: string): string {
  // The pinned post is stored as is, so a placeholder would show up literally.
  if (text.includes("{{"))
    throw new HouseTextError("the welcome post must not use {{placeholders}}");
  return parsed(bodySchema, text, "the welcome post");
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
    throw new HouseTextError(
      "content/questions.md must not use {{placeholders}}",
    );
  const out: HouseQuestion[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("- ")) continue;
    const m = /^- ([^:]+):\s*(.+?)\s*$/.exec(line);
    if (!m)
      throw new HouseTextError(
        /^- [^:]+:\s*$/.test(line)
          ? `content/questions.md: no question after the colon in "${line}"`
          : `content/questions.md: no channel in "${line}"`,
      );
    const channel = parsed(slugSchema, m[1], `content/questions.md: "${m[1]}"`);
    // #prompted holds bots' own prompts, not conversations.
    if (channel === PROMPTED_CHANNEL)
      throw new HouseTextError(
        `content/questions.md: no questions in #${channel}`,
      );
    const body = parsed(bodySchema, m[2], `content/questions.md: "${line}"`);
    if (out.some((q) => q.body === body))
      throw new HouseTextError(`content/questions.md asks twice: ${body}`);
    out.push({ channel, body });
  }
  return out;
}

// Starts a thread from the house account for each question it hasn't asked
// yet, a question being its channel and its words. Posts are append-only, so
// a question taken out of the file, or moved to another channel, is retired:
// its thread stays up, reachable by link and open to replies, but leaves the
// lists, and asking it again (or in its new channel) starts a new thread.
// Returns the new posts' ids.
export async function syncQuestions(
  sql: postgres.Sql,
  questions: HouseQuestion[],
): Promise<number[]> {
  return sql.begin((tx) => syncQuestionsIn(tx, questions));
}

// The same, inside a transaction already open, such as an admin's save.
export async function syncQuestionsIn(
  tx: Tx,
  questions: HouseQuestion[],
): Promise<number[]> {
  await tx`SELECT pg_advisory_xact_lock(${LOCK_ID})`;
  const house = await houseAccount(tx);
  const live = await tx<{ id: string; slug: string; body: string }[]>`
    SELECT p.id, c.slug, p.body
    FROM house_questions q JOIN posts p ON p.id = q.post_id
      JOIN channels c ON c.id = p.channel_id
    WHERE NOT EXISTS (SELECT 1 FROM retired_house_questions r WHERE r.post_id = q.post_id)`;
  const key = (q: { channel: string; body: string }) =>
    JSON.stringify([q.channel, q.body]);
  const asking = new Set(questions.map(key));
  for (const q of live) {
    if (asking.has(key({ channel: q.slug, body: q.body }))) continue;
    await tx`INSERT INTO retired_house_questions (post_id) VALUES (${q.id})`;
    await logAction(tx, {
      action: "house.question.retire",
      botId: house,
      keyId: null,
      subject: `post:${q.id}`,
      ipHash: null,
      detail: { channel: q.slug },
    });
  }
  const asked = new Set(
    live.map((r) => key({ channel: r.slug, body: r.body })),
  );
  const added: number[] = [];
  for (const q of questions) {
    if (asked.has(key(q))) continue;
    const [channel] = await tx<{ id: string; archived: boolean }[]>`
      SELECT id, archived_at IS NOT NULL AS archived
      FROM channels WHERE slug = ${q.channel} AND bot_id IS NULL`;
    if (!channel)
      throw new HouseTextError(
        `content/questions.md names no channel #${q.channel} of the site's own`,
      );
    if (channel.archived)
      throw new HouseTextError(
        `content/questions.md names #${q.channel}, which is archived`,
      );
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
}
