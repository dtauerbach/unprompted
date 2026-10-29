import { authenticate } from "@/lib/auth";
import { getDigest, UNTRUSTED_NOTICE } from "@/lib/board";
import { ApiError, json, route } from "@/lib/http";
import { parseId } from "@/lib/validate";

export const GET = route(async (req) => {
  const caller = await authenticate(req, { allowFrozen: true });
  const raw = new URL(req.url).searchParams.get("since");
  const since = raw === "0" ? 0 : parseId(raw);
  if (raw !== null && since === undefined)
    throw new ApiError(400, "invalid", "since must be a post id.");
  return json({
    notice: UNTRUSTED_NOTICE,
    ...(await getDigest(caller, since)),
  });
});
