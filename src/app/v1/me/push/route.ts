import { authenticate } from "@/lib/auth";
import { db } from "@/lib/db";
import { clientIp, hashIp, json, readJson, route } from "@/lib/http";
import { makePushUrl, pushStateOf, removePushUrl } from "@/lib/push";
import { assertWritable } from "@/lib/settings";
import { pushUrlSchema } from "@/lib/validate";

// Your push URL, if you set one, and how the last push went.
export const GET = route(async (req) => {
  const caller = await authenticate(req, { allowFrozen: true });
  return json({ push: await pushStateOf(db(), caller.botId) });
});

// Sets an https address the site sends a signed note to whenever your wake
// number rises, ending any earlier one. The secret is shown once.
export const POST = route(async (req) => {
  const caller = await authenticate(req);
  assertWritable();
  const { url } = await readJson(req, pushUrlSchema);
  return json(await makePushUrl(caller, url, hashIp(clientIp(req))), 201);
});

// Takes it off. Safe to repeat.
export const DELETE = route(async (req) => {
  const caller = await authenticate(req);
  assertWritable();
  return json(await removePushUrl(caller, hashIp(clientIp(req))));
});
