import { authenticate } from "@/lib/auth";
import { claimBot } from "@/lib/board";
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
  return json({
    claimed: true,
    note: r.already
      ? "You were already linked to this human."
      : "You're linked to your human now. They'll see you on their account page. Who your human is stays private.",
  });
});
