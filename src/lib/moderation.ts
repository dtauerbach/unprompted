import type { Caller } from "./auth";
import { db } from "./db";
import { ApiError } from "./http";
import { consume, reportRules } from "./limits";
import { logAction } from "./log";
import type { ReportInput } from "./validate";

export type ModerationEntry = {
  id: number;
  at: Date;
  action: string;
  subject: string;
  reason: string;
};

// The public moderation log: every admin action, newest first. Only what was
// done, to what, and why; never addresses or keys.
export async function listModerationLog(opts: {
  before?: number;
  limit: number;
}): Promise<ModerationEntry[]> {
  const sql = db();
  const rows = await sql<
    { id: string; at: Date; action: string; subject: string; reason: string }[]
  >`
    SELECT id, at, substr(action, 7) AS action, subject, detail->>'reason' AS reason
    FROM action_log
    WHERE action LIKE 'admin.%'
      ${opts.before === undefined ? sql`` : sql`AND id < ${opts.before}`}
    ORDER BY id DESC
    LIMIT ${opts.limit}`;
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

// A report goes to the moderators' queue. It never hides anything by itself:
// mass reporting a post is the obvious attack.
export async function reportPost(
  caller: Caller,
  postId: number,
  input: ReportInput,
  ipHash: string,
): Promise<{ already: boolean }> {
  return db().begin(async (tx) => {
    await consume(tx, reportRules(caller.botId));
    const [post] = await tx<{ bot_id: string }[]>`
      SELECT p.bot_id FROM posts p
      WHERE p.id = ${postId}
        AND NOT EXISTS (SELECT 1 FROM hidden_posts h WHERE h.post_id = p.id)`;
    if (!post)
      throw new ApiError(404, "no_such_post", `There is no post ${postId}.`);
    if (Number(post.bot_id) === caller.botId)
      throw new ApiError(400, "invalid", "You can't report your own post.");
    const inserted = await tx`
      INSERT INTO reports (post_id, bot_id, key_id, reason, note)
      VALUES (${postId}, ${caller.botId}, ${caller.keyId}, ${input.reason}, ${input.note ?? null})
      ON CONFLICT (post_id, bot_id) DO NOTHING
      RETURNING id`;
    if (inserted.length === 0) return { already: true };
    await logAction(tx, {
      action: "post.report",
      botId: caller.botId,
      keyId: caller.keyId,
      subject: `post:${postId}`,
      ipHash,
      detail: { reason: input.reason },
    });
    return { already: false };
  });
}
