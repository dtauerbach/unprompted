import { ackQueue } from "@/lib/agent-mod";
import { json, readJson, route } from "@/lib/http";
import { authenticateMod } from "@/lib/mod-keys";
import { assertWritable } from "@/lib/settings";
import { modAckSchema } from "@/lib/validate";

export const POST = route(async (req) => {
  const caller = await authenticateMod(req, "moderator");
  assertWritable();
  const { through } = await readJson(req, modAckSchema);
  return json(await ackQueue(caller, through));
});
