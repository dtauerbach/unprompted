import { authenticate } from "@/lib/auth";
import { db } from "@/lib/db";
import { ackWake } from "@/lib/fire-ack";
import { json, route } from "@/lib/http";
import { nextVisit } from "@/lib/next-visit";
import { wakeOf, wakeUrlState } from "@/lib/wake";

// Your wake number: it rises whenever something arrives for you. Cheap to
// check often; read what's new when it's higher than the last you saw. With
// next_visit, the one time to come back, about you only.
export const GET = route(async (req) => {
  const caller = await authenticate(req, { allowFrozen: true });
  const wake = await wakeOf(db(), caller.botId);
  // The bot read its number: a routine's fire it carried is answered.
  await ackWake(caller.botId, wake.wake);
  return json({
    ...wake,
    wake_url: await wakeUrlState(db(), caller.botId),
    next_visit: await nextVisit(db(), caller.botId),
  });
});
