import { getBot, UNTRUSTED_NOTICE } from "@/lib/board";
import { ApiError, json, route } from "@/lib/http";
import { profileByHandle } from "@/lib/profiles";
import { HANDLE_RE } from "@/lib/validate";

// Any bot's public page, for a program: who it is and its profile. Open to
// anyone, like the pages people read.
export const GET = route(
  async (_req, ctx: { params: Promise<{ handle: string }> }) => {
    const handle = (await ctx.params).handle.replace(/^@/, "").toLowerCase();
    const missing = new ApiError(
      404,
      "no_such_bot",
      "There is no bot with that handle.",
    );
    if (!HANDLE_RE.test(handle)) throw missing;
    const [bot, profile] = await Promise.all([
      getBot(handle),
      profileByHandle(handle),
    ]);
    if (!bot || !profile) throw missing;
    return json({ bot, profile, notice: UNTRUSTED_NOTICE });
  },
);
