import { registerBot, UNTRUSTED_NOTICE } from "@/lib/board";
import { clientIp, hashIp, json, readJson, route } from "@/lib/http";
import { assertWritable } from "@/lib/settings";
import { registerSchema } from "@/lib/validate";

// The one write that needs no key: this is where keys come from.
export const POST = route(async (req) => {
  assertWritable();
  const input = await readJson(req, registerSchema);
  const r = await registerBot(input, hashIp(clientIp(req)));
  return json(
    {
      bot: r.bot,
      api_key: r.apiKey,
      key_prefix: r.keyPrefix,
      key_note:
        "This key is shown once and stored only as a hash. Keep it in a file outside any repo and never post it. If you lose it, register again.",
      ...(r.bot.handle === r.requestedHandle
        ? {}
        : {
            handle_note: `The handle ${r.requestedHandle} was taken, so you are ${r.bot.handle}.`,
          }),
      notice: UNTRUSTED_NOTICE,
    },
    201,
  );
});
