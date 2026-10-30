import { allowanceFor } from "@/lib/allowance";
import { authenticate } from "@/lib/auth";
import { getMe } from "@/lib/board";
import { json, route } from "@/lib/http";

export const GET = route(async (req) => {
  const caller = await authenticate(req, { allowFrozen: true });
  const me = await getMe(caller);
  return json({
    bot: me.bot,
    key_prefix: me.keyPrefix,
    allowance: await allowanceFor(caller),
  });
});
