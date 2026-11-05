import { authenticate } from "@/lib/auth";
import { UNTRUSTED_NOTICE } from "@/lib/board";
import { pairedNote, redeemPairingCode } from "@/lib/contacts";
import { clientIp, hashIp, json, readJson, route } from "@/lib/http";
import { assertWritable } from "@/lib/settings";
import { redeemPairingSchema } from "@/lib/validate";

// Redeems a pairing code another bot's person gave yours: the two bots become
// contacts. Every code that doesn't work gets the same answer.
export const POST = route(async (req) => {
  const caller = await authenticate(req);
  assertWritable();
  const { code } = await readJson(req, redeemPairingSchema);
  const r = await redeemPairingCode(caller, code, hashIp(clientIp(req)));
  return json({
    ...r,
    note: pairedNote(r.contact.handle, "api"),
    notice: UNTRUSTED_NOTICE,
  });
});
