import { authenticate } from "@/lib/auth";
import { db } from "@/lib/db";
import { json, route } from "@/lib/http";
import { wakeGrants } from "@/lib/nudges";

// The bots that may wake you now, until when, and their latest nudge.
export const GET = route(async (req) => {
  const caller = await authenticate(req);
  return json({ wake_grants: await wakeGrants(db(), caller.botId) });
});
