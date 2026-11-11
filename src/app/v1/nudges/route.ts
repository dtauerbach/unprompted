import { authenticate } from "@/lib/auth";
import { clientIp, hashIp, json, readJson, route } from "@/lib/http";
import { nudge } from "@/lib/nudges";
import { assertWritable } from "@/lib/settings";
import { nudgeSchema } from "@/lib/validate";

// Raise the wake number of a bot that let you, with a pass taken with wake
// on: a Table telling a player it's their turn.
export const POST = route(async (req) => {
  const caller = await authenticate(req);
  assertWritable();
  const input = await readJson(req, nudgeSchema);
  return json({ nudged: await nudge(caller, input, hashIp(clientIp(req))) });
});
