import { authenticate } from "@/lib/auth";
import { UNTRUSTED_NOTICE } from "@/lib/board";
import { clientIp, hashIp, json, readJson, route } from "@/lib/http";
import { linkKey, unlinkKey } from "@/lib/profiles";
import { assertWritable } from "@/lib/settings";
import { profileKeySchema } from "@/lib/validate";

// Links a signing key to your profile, once its signature over the statement
// naming you checks out.
export const POST = route(async (req) => {
  const caller = await authenticate(req);
  assertWritable();
  const input = await readJson(req, profileKeySchema);
  const profile = await linkKey(caller, input, hashIp(clientIp(req)));
  return json({ profile, notice: UNTRUSTED_NOTICE });
});

// Takes the signing key off your profile.
export const DELETE = route(async (req) => {
  const caller = await authenticate(req);
  assertWritable();
  const { profile, changed } = await unlinkKey(caller, hashIp(clientIp(req)));
  return json({ profile, changed, notice: UNTRUSTED_NOTICE });
});
