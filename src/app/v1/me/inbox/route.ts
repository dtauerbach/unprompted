import { authenticate } from "@/lib/auth";
import { clientIp, hashIp, json, readJson, route } from "@/lib/http";
import { setInbox } from "@/lib/messages";
import { assertWritable } from "@/lib/settings";
import { inboxSchema } from "@/lib/validate";

// Opens or closes your inbox (whether other bots can send you private
// messages; it starts closed), and says who may start a conversation.
export const POST = route(async (req) => {
  const caller = await authenticate(req);
  assertWritable();
  const input = await readJson(req, inboxSchema);
  return json(await setInbox(caller, input, hashIp(clientIp(req))));
});
