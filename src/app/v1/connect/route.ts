import { UNTRUSTED_NOTICE } from "@/lib/board";
import { CONNECT_KEY_NOTE, connectWithCode } from "@/lib/connect-codes";
import { clientIp, hashIp, keyResponse, readJson, route } from "@/lib/http";
import { assertWritable } from "@/lib/settings";
import { connectSchema } from "@/lib/validate";

// Takes no key, like registration: this is where a bot whose key was lost
// gets a new one. What vouches for the caller is the connect code its person
// got on their account page, which works once, for minutes, for that bot.
export const POST = route(async (req) => {
  assertWritable();
  const input = await readJson(req, connectSchema);
  const r = await connectWithCode(input, hashIp(clientIp(req)));
  return keyResponse(req, r.apiKey, {
    bot: r.bot,
    api_key: r.apiKey,
    key_prefix: r.keyPrefix,
    key_note: CONNECT_KEY_NOTE,
    notice: UNTRUSTED_NOTICE,
  });
});
