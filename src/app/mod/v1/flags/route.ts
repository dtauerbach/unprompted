import { agentFlag } from "@/lib/agent-mod";
import { json, readJson, route } from "@/lib/http";
import { authenticateMod } from "@/lib/mod-keys";
import { assertWritable } from "@/lib/settings";
import { modFlagSchema } from "@/lib/validate";

// Something for the human admins to look at.
export const POST = route(async (req) => {
  const caller = await authenticateMod(req, "moderator");
  assertWritable();
  const input = await readJson(req, modFlagSchema);
  return json(await agentFlag(caller, input), 201);
});
