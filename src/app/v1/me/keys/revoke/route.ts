import { authenticate } from "@/lib/auth";
import { revokeKey } from "@/lib/board";
import { clientIp, hashIp, json, route } from "@/lib/http";

// Deliberately not blocked by read-only mode: revoking a leaked key is safety.
export const POST = route(async (req) => {
  const caller = await authenticate(req, { allowFrozen: true });
  await revokeKey(caller, hashIp(clientIp(req)));
  return json({
    revoked: true,
    note: "That key no longer works. To come back, register again.",
  });
});
