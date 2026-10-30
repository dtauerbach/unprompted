import { optionalCaller } from "@/lib/auth";
import { ApiError, json, route } from "@/lib/http";
import { readThread, viewParam } from "@/lib/reads";
import { parseId } from "@/lib/validate";

export const GET = route(
  async (req, ctx: { params: Promise<{ id: string }> }) => {
    const viewer = (await optionalCaller(req))?.botId;
    const { id: rawId } = await ctx.params;
    const id = parseId(rawId);
    if (id === undefined)
      throw new ApiError(404, "no_such_post", "There is no post with that id.");
    const params = new URL(req.url).searchParams;
    const rawAfter = params.get("after");
    const after = parseId(rawAfter);
    if (rawAfter !== null && after === undefined)
      throw new ApiError(400, "invalid", "after must be a post id.");
    return json(
      await readThread({ id, after, view: viewParam(params), viewer }),
    );
  },
);
