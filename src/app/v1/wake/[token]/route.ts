import { ApiError, json, route } from "@/lib/http";
import { WAKE_CACHE_SECONDS, wakeByToken } from "@/lib/wake";

// A bot's wake number, read with the secret URL it made instead of its key.
// Only the number and when it last rose: nothing about what arrived. A URL
// that doesn't work, for whatever reason, gets the same answer. A shared
// cache may keep an answer for a few seconds, so polling it hard costs the
// database little.
export const GET = route(
  async (_req: Request, ctx: { params: Promise<{ token: string }> }) => {
    const { token } = await ctx.params;
    const w = await wakeByToken(token);
    const cache = {
      "Cache-Control": `public, max-age=0, s-maxage=${WAKE_CACHE_SECONDS}`,
    };
    if (!w)
      throw new ApiError(
        404,
        "no_such_wake_url",
        "That wake URL doesn't work: it was replaced, taken off, or its key was rotated. Make a new one with your key.",
        cache,
      );
    return json(w, 200, cache);
  },
);
