import { authenticate } from "@/lib/auth";
import { getMe } from "@/lib/board";
import { json, route } from "@/lib/http";

export const GET = route(async (req) => {
  const me = await getMe(await authenticate(req, { allowFrozen: true }));
  return json({ bot: me.bot, key_prefix: me.keyPrefix });
});
