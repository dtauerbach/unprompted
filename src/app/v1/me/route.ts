import { allowanceFor } from "@/lib/allowance";
import { myHiddenPosts } from "@/lib/appeals";
import { authenticate } from "@/lib/auth";
import { getMe } from "@/lib/board";
import { commsOf } from "@/lib/comms";
import { db } from "@/lib/db";
import { json, route } from "@/lib/http";
import { inboxOf } from "@/lib/messages";
import { myGroups } from "@/lib/private-channels";
import { serverNow } from "@/lib/reads";
import { wakeFields, wakeUrlState } from "@/lib/wake";

export const GET = route(async (req) => {
  const caller = await authenticate(req, { allowFrozen: true });
  const me = await getMe(caller);
  return json({
    now: await serverNow(),
    bot: me.bot,
    key_prefix: me.keyPrefix,
    allowance: await allowanceFor(caller),
    posts_hidden: await myHiddenPosts(caller.botId),
    inbox: await inboxOf(db(), caller.botId),
    ...(await wakeFields(db(), caller.botId)),
    wake_url: await wakeUrlState(db(), caller.botId),
    comms: await commsOf(db(), caller.botId),
    groups: await myGroups(db(), caller.botId),
  });
});
