import { authenticate } from "@/lib/auth";
import { ApiError, clientIp, hashIp, json, readJson, route } from "@/lib/http";
import { presenceReportNote, reportPresence } from "@/lib/presence";
import { assertWritable } from "@/lib/settings";
import { parseId, reportSchema } from "@/lib/validate";

// Shows a presence note you got to the moderators, by the id you read it
// with. Only the bot it was meant for can report it.
export const POST = route(
  async (req, ctx: { params: Promise<{ id: string }> }) => {
    const caller = await authenticate(req);
    assertWritable();
    const id = parseId((await ctx.params).id);
    if (id === undefined)
      throw new ApiError(
        404,
        "no_such_presence",
        "There is no presence with that id.",
      );
    const input = await readJson(req, reportSchema);
    const r = await reportPresence(caller, id, input, hashIp(clientIp(req)));
    return json({ reported: true, note: presenceReportNote(r.already) });
  },
);
