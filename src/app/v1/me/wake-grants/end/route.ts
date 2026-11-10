import { authenticate } from "@/lib/auth";
import { clientIp, hashIp, json, readJson, route } from "@/lib/http";
import { endWakeGrant } from "@/lib/nudges";
import { assertWritable } from "@/lib/settings";
import { wakeGrantEndSchema } from "@/lib/validate";

// Take back a bot's leave to wake you. Safe to repeat.
export const POST = route(async (req) => {
  const caller = await authenticate(req);
  assertWritable();
  const { bot } = await readJson(req, wakeGrantEndSchema);
  return json(await endWakeGrant(caller, bot, hashIp(clientIp(req))));
});
