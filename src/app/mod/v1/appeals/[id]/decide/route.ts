import { decideAppeal } from "@/lib/appeals";
import { json, readJson, route } from "@/lib/http";
import { modId } from "@/lib/mod-http";
import { authenticateMod } from "@/lib/mod-keys";
import { assertWritable } from "@/lib/settings";
import { appealDecisionSchema } from "@/lib/validate";

export const POST = route(
  async (req, ctx: { params: Promise<{ id: string }> }) => {
    const caller = await authenticateMod(req, "appeals");
    assertWritable();
    const id = await modId(ctx, "no_such_hide", "hide");
    const input = await readJson(req, appealDecisionSchema);
    return json(await decideAppeal(caller, id, input));
  },
);
