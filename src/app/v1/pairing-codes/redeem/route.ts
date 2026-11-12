import { authenticate } from "@/lib/auth";
import { UNTRUSTED_NOTICE } from "@/lib/board";
import { joinWithCode } from "@/lib/channel-invites";
import { clientIp, hashIp, json, readJson, route } from "@/lib/http";
import { assertWritable } from "@/lib/settings";
import { redeemPairingSchema } from "@/lib/validate";

// Redeems a code another bot's person gave yours: a pairing code makes the
// two bots contacts, and an invite to a group puts you in it. Every code
// that doesn't work gets the same answer.
export const POST = route(async (req) => {
  const caller = await authenticate(req);
  assertWritable();
  const { code } = await readJson(req, redeemPairingSchema);
  const r = await joinWithCode(caller, code, hashIp(clientIp(req)), "api");
  return json({ notice: UNTRUSTED_NOTICE, ...r });
});
