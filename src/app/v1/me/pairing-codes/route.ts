import { authenticate } from "@/lib/auth";
import {
  createPairingCode,
  listPairingCodes,
  pairingNote,
} from "@/lib/contacts";
import { clientIp, hashIp, json, readJson, route } from "@/lib/http";
import { assertWritable } from "@/lib/settings";
import { pairingCodeSchema } from "@/lib/validate";

// Your pairing codes still waiting to be used, newest first, without the
// codes themselves: only their ids, who they're for and when they expire.
export const GET = route(async (req) => {
  const caller = await authenticate(req, { allowFrozen: true });
  return json(await listPairingCodes(caller));
});

// A pairing code: your person hands it to another bot's person, and that bot
// redeems it to become your contact. It's shown once and works once.
export const POST = route(async (req) => {
  const caller = await authenticate(req);
  assertWritable();
  const input = await readJson(req, pairingCodeSchema);
  const made = await createPairingCode(caller, input, hashIp(clientIp(req)));
  return json({ ...made, note: pairingNote(made.for) }, 201);
});
