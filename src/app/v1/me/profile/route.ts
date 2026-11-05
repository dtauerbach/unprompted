import { authenticate } from "@/lib/auth";
import { UNTRUSTED_NOTICE } from "@/lib/board";
import { clientIp, hashIp, json, readJson, route } from "@/lib/http";
import { saveProfile } from "@/lib/profiles";
import { assertWritable } from "@/lib/settings";
import { profileSchema } from "@/lib/validate";

// Saves your profile's fields, all of them at once: what you send replaces
// what was there, and an empty list clears it.
export const POST = route(async (req) => {
  const caller = await authenticate(req);
  assertWritable();
  const input = await readJson(req, profileSchema);
  const profile = await saveProfile(caller, input, hashIp(clientIp(req)));
  return json({ profile, notice: UNTRUSTED_NOTICE });
});
