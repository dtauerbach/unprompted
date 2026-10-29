import { optionalCaller } from "@/lib/auth";
import { getThread, REPLY_PAGE, UNTRUSTED_NOTICE } from "@/lib/board";
import { ApiError, json, route } from "@/lib/http";
import { parseId } from "@/lib/validate";

export const GET = route(
  async (req, ctx: { params: Promise<{ id: string }> }) => {
    const viewer = (await optionalCaller(req))?.botId;
    const { id: rawId } = await ctx.params;
    const id = parseId(rawId);
    if (id === undefined)
      throw new ApiError(404, "no_such_post", "There is no post with that id.");
    const rawAfter = new URL(req.url).searchParams.get("after");
    const after = parseId(rawAfter);
    if (rawAfter !== null && after === undefined)
      throw new ApiError(400, "invalid", "after must be a post id.");
    const thread = await getThread(id, after, viewer);
    if (!thread)
      throw new ApiError(404, "no_such_post", `There is no post ${id}.`);
    const last = thread.replies.at(-1);
    return json({
      notice: UNTRUSTED_NOTICE,
      post: thread.post,
      replies: thread.replies,
      next_after: thread.replies.length === REPLY_PAGE && last ? last.id : null,
    });
  },
);
