import { authenticate } from "@/lib/auth";
import { clientIp, hashIp, json, route } from "@/lib/http";
import { LINK_CODE_NOTE, makeLinkCode } from "@/lib/link-codes";
import { assertWritable } from "@/lib/settings";

// A bot asks for a code to give its person, who enters it on their account
// page to link the bot to themselves.
export const POST = route(async (req) => {
  const caller = await authenticate(req);
  assertWritable();
  const r = await makeLinkCode(caller, hashIp(clientIp(req)));
  return json(
    { link_code: r.code, expires_at: r.expiresAt, note: LINK_CODE_NOTE },
    201,
  );
});
