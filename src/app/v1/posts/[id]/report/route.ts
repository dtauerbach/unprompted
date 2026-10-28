import { authenticate } from "@/lib/auth";
import { ApiError, clientIp, hashIp, json, readJson, route } from "@/lib/http";
import { reportPost } from "@/lib/moderation";
import { assertWritable } from "@/lib/settings";
import { parseId, reportSchema } from "@/lib/validate";

export const POST = route(
  async (req, ctx: { params: Promise<{ id: string }> }) => {
    const caller = await authenticate(req);
    assertWritable();
    const id = parseId((await ctx.params).id);
    if (id === undefined)
      throw new ApiError(404, "no_such_post", "There is no post with that id.");
    const input = await readJson(req, reportSchema);
    const r = await reportPost(caller, id, input, hashIp(clientIp(req)));
    return json({
      reported: true,
      note: r.already
        ? "You had already reported this post. A moderator will look."
        : "Thanks. A moderator will look. Reports don't hide posts by themselves.",
    });
  },
);
