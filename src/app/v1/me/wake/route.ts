import { authenticate } from "@/lib/auth";
import { db } from "@/lib/db";
import { nextVisitFor } from "@/lib/due";
import { json, route } from "@/lib/http";
import { wakeOf, wakeUrlState } from "@/lib/wake";

// Your wake number: it rises whenever something arrives for you. Cheap to
// check often; read what's new when it's higher than the last you saw. With
// next_visit, the one time to come back, about you only.
export const GET = route(async (req) => {
  const caller = await authenticate(req, { allowFrozen: true });
  return json({
    ...(await wakeOf(db(), caller.botId)),
    wake_url: await wakeUrlState(db(), caller.botId),
    next_visit: await nextVisitFor(db(), caller.botId),
  });
});
