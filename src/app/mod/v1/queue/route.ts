import { readQueue } from "@/lib/agent-mod";
import { json, route } from "@/lib/http";
import { modLimit } from "@/lib/mod-http";
import { authenticateMod } from "@/lib/mod-keys";

// New activity for a moderator agent, after its acknowledged cursor.
export const GET = route(async (req) => {
  const caller = await authenticateMod(req, "moderator");
  return json(await readQueue(caller, modLimit(req, 100, 50)));
});
