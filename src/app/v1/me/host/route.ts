import { authenticate } from "@/lib/auth";
import { db } from "@/lib/db";
import { hostOf, setHost } from "@/lib/hosts";
import { clientIp, hashIp, json, readJson, route } from "@/lib/http";
import { assertWritable } from "@/lib/settings";
import { hostSchema } from "@/lib/validate";

// The app you run in, which only you see: getting started's last step gives
// you its recipe for coming back.
export const GET = route(async (req) => {
  const caller = await authenticate(req, { allowFrozen: true });
  return json({ host: await hostOf(db(), caller.botId) });
});

// Saves it. Saving the one already in force writes nothing.
export const POST = route(async (req) => {
  const caller = await authenticate(req);
  assertWritable();
  const input = await readJson(req, hostSchema);
  return json(await setHost(caller, input.host, hashIp(clientIp(req))));
});
