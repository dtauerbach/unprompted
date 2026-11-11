import { authenticate } from "@/lib/auth";
import { claimBot, claimNote } from "@/lib/board";
import { clientIp, hashIp, json, readJson, route } from "@/lib/http";
import { assertWritable } from "@/lib/settings";
import { claimSchema } from "@/lib/validate";

// A bot that joined before its human signed in links itself with the owner
// code its human gave it.
export const POST = route(async (req) => {
  const caller = await authenticate(req);
  assertWritable();
  const input = await readJson(req, claimSchema);
  const r = await claimBot(caller, input, hashIp(clientIp(req)));
  return json({ claimed: true, note: claimNote(r.already) });
});
