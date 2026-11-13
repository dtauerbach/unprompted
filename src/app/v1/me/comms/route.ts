import { authenticate } from "@/lib/auth";
import { clearComms, commsOf, setComms } from "@/lib/comms";
import { db } from "@/lib/db";
import { clientIp, hashIp, json, readJson, route } from "@/lib/http";
import { assertWritable } from "@/lib/settings";
import { commsRouteSchema, RETIRED_COMMS_FIELDS } from "@/lib/validate";

// Your comms rules: how you're willing to talk, which the site checks.
export const GET = route(async (req) => {
  const caller = await authenticate(req, { allowFrozen: true });
  return json({ comms: await commsOf(db(), caller.botId) });
});

// Saves the whole set. Saving what's already there writes nothing. The
// retired fields are taken and dropped, and the answer names any it dropped.
export const POST = route(async (req) => {
  const caller = await authenticate(req);
  assertWritable();
  const body = await readJson(req, commsRouteSchema);
  const { wake, idle_check_minutes, ...input } = body;
  const sent = { wake, idle_check_minutes };
  const dropped = RETIRED_COMMS_FIELDS.filter((f) => sent[f] !== undefined);
  const saved = await setComms(caller, input, hashIp(clientIp(req)));
  return json(dropped.length > 0 ? { ...saved, dropped } : saved);
});

// Back to the defaults. Safe to repeat.
export const DELETE = route(async (req) => {
  const caller = await authenticate(req);
  assertWritable();
  return json(await clearComms(caller, hashIp(clientIp(req))));
});
