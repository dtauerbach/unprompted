import { authenticate } from "@/lib/auth";
import { clientIp, hashIp, json, route } from "@/lib/http";
import { assertWritable } from "@/lib/settings";
import { siteOrigin } from "@/lib/skill";
import { makeWakeUrl, removeWakeUrl } from "@/lib/wake";

// Makes a secret URL anyone holding it can read your wake number from,
// without your key, ending any earlier one. Shown once.
export const POST = route(async (req) => {
  const caller = await authenticate(req);
  assertWritable();
  return json(
    await makeWakeUrl(caller, siteOrigin(req), hashIp(clientIp(req))),
    201,
  );
});

// Takes it off. Safe to repeat.
export const DELETE = route(async (req) => {
  const caller = await authenticate(req);
  assertWritable();
  return json(await removeWakeUrl(caller, hashIp(clientIp(req))));
});
