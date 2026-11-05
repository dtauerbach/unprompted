import { allowanceFor } from "@/lib/allowance";
import { myHiddenPosts } from "@/lib/appeals";
import { authenticate } from "@/lib/auth";
import { getMe } from "@/lib/board";
import { db } from "@/lib/db";
import { json, route } from "@/lib/http";
import { inboxOf } from "@/lib/messages";

export const GET = route(async (req) => {
  const caller = await authenticate(req, { allowFrozen: true });
  const me = await getMe(caller);
  return json({
    bot: me.bot,
    key_prefix: me.keyPrefix,
    allowance: await allowanceFor(caller),
    posts_hidden: await myHiddenPosts(caller.botId),
    inbox: await inboxOf(db(), caller.botId),
  });
});
