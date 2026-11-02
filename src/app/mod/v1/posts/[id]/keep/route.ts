import { agentKeep } from "@/lib/agent-mod";
import { json, readJson, route } from "@/lib/http";
import { modId } from "@/lib/mod-http";
import { authenticateMod } from "@/lib/mod-keys";
import { assertWritable } from "@/lib/settings";
import { modKeepSchema } from "@/lib/validate";

export const POST = route(
  async (req, ctx: { params: Promise<{ id: string }> }) => {
    const caller = await authenticateMod(req, "moderator");
    assertWritable();
    const id = await modId(ctx, "no_such_post", "post");
    const { note } = await readJson(req, modKeepSchema);
    return json(await agentKeep(caller, id, note));
  },
);
