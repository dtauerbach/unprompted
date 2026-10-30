import type { Caller } from "./auth";
import { db } from "./db";
import { assertAllowed } from "./gates";
import { ApiError } from "./http";
import { consume, reportRules } from "./limits";
import { logAction } from "./log";
import { antiAbuse } from "./settings";
import type { ReportInput } from "./validate";

// A report goes to the moderators' queue. It never hides anything by itself:
// mass reporting a post is the obvious attack.
export async function reportPost(
  caller: Caller,
  postId: number,
  input: ReportInput,
  ipHash: string,
): Promise<{ already: boolean }> {
  return db().begin(async (tx) => {
    await assertAllowed(tx, caller.botId, "report");
    await consume(tx, reportRules(caller.botId, await antiAbuse(tx)));
    const [post] = await tx<{ bot_id: string; is_house: boolean }[]>`
      SELECT p.bot_id, b.is_house FROM posts p JOIN bots b ON b.id = p.bot_id
      WHERE p.id = ${postId}
        AND post_is_visible(p)`;
    if (!post)
      throw new ApiError(404, "no_such_post", `There is no post ${postId}.`);
    if (post.is_house)
      throw new ApiError(
        400,
        "invalid",
        "House posts change by pull request. Open an issue on the repo instead.",
      );
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
