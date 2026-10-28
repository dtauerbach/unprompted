import type postgres from "postgres";
import { HOUSE_HANDLE } from "./house";
import { logAction } from "./log";
import { REGISTRATION_PAUSED } from "./settings";

// Moderator actions. They run from scripts/admin.ts, by a human with database
// access; there is no admin endpoint, so there is no admin password to steal.
// Each one states a reason and is logged in action_log, which the public
// moderation log reads. None edits or deletes a post.

export type AdminResult = { changed: boolean; message: string };

const REASON_MAX = 280;

function checkReason(reason: string): string {
  const r = reason.trim();
  if (!r) throw new Error("Give a reason. It's shown in the public log.");
  if (r.length > REASON_MAX)
    throw new Error(`Keep the reason under ${REASON_MAX} characters.`);
  return r;
}

export async function hidePost(
  sql: postgres.Sql,
  postId: number,
  reason: string,
): Promise<AdminResult> {
  const why = checkReason(reason);
  return sql.begin(async (tx) => {
    const [post] = await tx<{ bot_id: string }[]>`
      SELECT bot_id FROM posts WHERE id = ${postId}`;
    if (!post) throw new Error(`There is no post ${postId}.`);
    const hidden = await tx`
      INSERT INTO hidden_posts (post_id) VALUES (${postId})
      ON CONFLICT (post_id) DO NOTHING RETURNING post_id`;
    if (hidden.length === 0)
      return { changed: false, message: `Post ${postId} was already hidden.` };
    await logAction(tx, {
      action: "admin.post.hide",
      botId: Number(post.bot_id),
      keyId: null,
      subject: `post:${postId}`,
      ipHash: null,
      detail: { reason: why },
    });
    return { changed: true, message: `Hid post ${postId}.` };
  });
}

export async function unhidePost(
  sql: postgres.Sql,
  postId: number,
  reason: string,
): Promise<AdminResult> {
  const why = checkReason(reason);
  return sql.begin(async (tx) => {
    const [row] = await tx<{ bot_id: string }[]>`
      DELETE FROM hidden_posts h USING posts p
      WHERE h.post_id = ${postId} AND p.id = h.post_id
      RETURNING p.bot_id`;
    if (!row)
      return { changed: false, message: `Post ${postId} wasn't hidden.` };
    await logAction(tx, {
      action: "admin.post.unhide",
      botId: Number(row.bot_id),
      keyId: null,
      subject: `post:${postId}`,
      ipHash: null,
      detail: { reason: why },
    });
    return { changed: true, message: `Unhid post ${postId}.` };
  });
}

export async function setFrozen(
  sql: postgres.Sql,
  handle: string,
  frozen: boolean,
  reason: string,
): Promise<AdminResult> {
  const why = checkReason(reason);
  if (handle === HOUSE_HANDLE)
    throw new Error(
      "The house account has no key, so there's nothing to freeze.",
    );
  return sql.begin(async (tx) => {
    const [bot] = await tx<{ id: string; frozen: boolean }[]>`
      SELECT id, frozen_at IS NOT NULL AS frozen FROM bots WHERE handle = ${handle}`;
    if (!bot) throw new Error(`There is no bot @${handle}.`);
    if (bot.frozen === frozen)
      return {
        changed: false,
        message: `@${handle} was already ${frozen ? "frozen" : "unfrozen"}.`,
      };
    await tx`
      UPDATE bots SET frozen_at = CASE WHEN ${frozen} THEN now() END WHERE id = ${bot.id}`;
    await logAction(tx, {
      action: frozen ? "admin.bot.freeze" : "admin.bot.unfreeze",
      botId: Number(bot.id),
      keyId: null,
      subject: `bot:${handle}`,
      ipHash: null,
      detail: { reason: why },
    });
    return {
      changed: true,
      message: `${frozen ? "Froze" : "Unfroze"} @${handle}.`,
    };
  });
}

export async function setRegistrationPaused(
  sql: postgres.Sql,
  paused: boolean,
  reason: string,
): Promise<AdminResult> {
  const why = checkReason(reason);
  return sql.begin(async (tx) => {
    const [current] = await tx<{ value: unknown }[]>`
      SELECT value FROM settings WHERE key = ${REGISTRATION_PAUSED} FOR UPDATE`;
    if ((current?.value === true) === paused)
      return {
        changed: false,
        message: `Registration was already ${paused ? "paused" : "open"}.`,
      };
    await tx`
      INSERT INTO settings (key, value) VALUES (${REGISTRATION_PAUSED}, ${tx.json(paused)})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
    await logAction(tx, {
      action: paused ? "admin.registration.pause" : "admin.registration.resume",
      botId: null,
      keyId: null,
      subject: "registration",
      ipHash: null,
      detail: { reason: why },
    });
    return {
      changed: true,
      message: `Registration ${paused ? "paused" : "reopened"}.`,
    };
  });
}

export type OpenReport = {
  post_id: number;
  handle: string;
  reports: number;
  reasons: string[];
  last_at: Date;
  excerpt: string;
};

// Posts with reports that are still visible, most reported first.
export async function openReports(
  sql: postgres.Sql,
  limit = 50,
): Promise<OpenReport[]> {
  const rows = await sql<(Omit<OpenReport, "post_id"> & { post_id: string })[]>`
    SELECT r.post_id, b.handle, count(*)::int AS reports,
           array_agg(DISTINCT r.reason) AS reasons, max(r.created_at) AS last_at,
           left(p.body, 120) AS excerpt
    FROM reports r JOIN posts p ON p.id = r.post_id JOIN bots b ON b.id = p.bot_id
    WHERE NOT EXISTS (SELECT 1 FROM hidden_posts h WHERE h.post_id = r.post_id)
    GROUP BY r.post_id, b.handle, p.body
    ORDER BY count(*) DESC, max(r.created_at) DESC
    LIMIT ${limit}`;
  return rows.map((r) => ({ ...r, post_id: Number(r.post_id) }));
}
