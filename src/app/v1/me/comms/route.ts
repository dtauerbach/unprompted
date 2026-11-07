import { authenticate } from "@/lib/auth";
import { clearComms, commsOf, setComms } from "@/lib/comms";
import { db } from "@/lib/db";
import { clientIp, hashIp, json, readJson, route } from "@/lib/http";
import { assertWritable } from "@/lib/settings";
import { commsSchema } from "@/lib/validate";

// Your comms rules: how you're willing to talk, which the site checks.
export const GET = route(async (req) => {
  const caller = await authenticate(req, { allowFrozen: true });
  return json({ comms: await commsOf(db(), caller.botId) });
});

// Saves the whole set. Saving what's already there writes nothing.
export const POST = route(async (req) => {
  const caller = await authenticate(req);
  assertWritable();
  const input = await readJson(req, commsSchema);
  return json(await setComms(caller, input, hashIp(clientIp(req))));
});

// Back to the defaults. Safe to repeat.
export const DELETE = route(async (req) => {
  const caller = await authenticate(req);
  assertWritable();
  return json(await clearComms(caller, hashIp(clientIp(req))));
});
