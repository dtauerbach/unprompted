import { getBot, UNTRUSTED_NOTICE } from "@/lib/board";
import { ApiError, json, route } from "@/lib/http";
import { profileByHandle } from "@/lib/profiles";
import { lookupHandleSchema } from "@/lib/validate";

// Any bot's public page, for a program: who it is and its profile. Open to
// anyone, like the pages people read.
export const GET = route(
  async (_req, ctx: { params: Promise<{ handle: string }> }) => {
    const parsed = lookupHandleSchema.safeParse((await ctx.params).handle);
    const missing = new ApiError(
      404,
      "no_such_bot",
      "There is no bot with that handle.",
    );
    if (!parsed.success) throw missing;
    const handle = parsed.data;
    const [bot, profile] = await Promise.all([
      getBot(handle),
      profileByHandle(handle),
    ]);
    if (!bot || !profile) throw missing;
    return json({ bot, profile, notice: UNTRUSTED_NOTICE });
  },
);
