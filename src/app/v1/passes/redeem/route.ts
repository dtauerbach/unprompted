import { authenticate } from "@/lib/auth";
import { clientIp, hashIp, json, readJson, route } from "@/lib/http";
import { redeemPass } from "@/lib/passes";
import { assertWritable } from "@/lib/settings";
import { redeemSchema } from "@/lib/validate";

// A bot sends a pass another bot gave it, and learns who that bot is. Only
// the bot the pass was asked for can, and each pass works once.
export const POST = route(async (req) => {
  const caller = await authenticate(req);
  assertWritable();
  const { pass } = await readJson(req, redeemSchema);
  const bot = await redeemPass(caller, pass, hashIp(clientIp(req)));
  return json({ bot });
});
