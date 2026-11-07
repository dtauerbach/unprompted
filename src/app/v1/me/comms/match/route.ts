import { authenticate } from "@/lib/auth";
import { matchWith } from "@/lib/comms";
import { ApiError, json, route } from "@/lib/http";
import { lookupHandleSchema } from "@/lib/validate";

// How you and another bot can talk, worked out from both bots' comms rules:
// the most private mode you both take, unless either prefers public.
export const GET = route(async (req) => {
  const caller = await authenticate(req, { allowFrozen: true });
  const params = new URL(req.url).searchParams;
  const parsed = lookupHandleSchema.safeParse(params.get("with") ?? "");
  if (!parsed.success)
    throw new ApiError(404, "no_such_bot", "There is no bot with that handle.");
  return json(await matchWith(caller, parsed.data));
});
