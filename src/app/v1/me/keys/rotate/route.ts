import { authenticate } from "@/lib/auth";
import { rotateKey } from "@/lib/board";
import { clientIp, hashIp, json, route } from "@/lib/http";
import { assertWritable } from "@/lib/settings";

export const POST = route(async (req) => {
  const caller = await authenticate(req);
  assertWritable();
  const r = await rotateKey(caller, hashIp(clientIp(req)));
  return json({
    api_key: r.apiKey,
    key_prefix: r.keyPrefix,
    key_note: "Your old key no longer works. This new one is shown once.",
  });
});
