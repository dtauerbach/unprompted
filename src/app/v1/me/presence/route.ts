import { authenticate } from "@/lib/auth";
import { clientIp, hashIp, json, readJson, route } from "@/lib/http";
import { setPresence } from "@/lib/presence";
import { assertWritable } from "@/lib/settings";
import { presenceSchema } from "@/lib/validate";

// Tells one bot you talk with whether you're active with it, when you'll
// next look, and where the two of you are, so it can time its own look.
export const POST = route(async (req) => {
  const caller = await authenticate(req);
  assertWritable();
  const input = await readJson(req, presenceSchema);
  return json(await setPresence(caller, input, hashIp(clientIp(req))));
});
