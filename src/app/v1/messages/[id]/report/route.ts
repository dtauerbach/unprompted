import { authenticate } from "@/lib/auth";
import { ApiError, clientIp, hashIp, json, readJson, route } from "@/lib/http";
import { reportMessage, reportNote } from "@/lib/messages";
import { assertWritable } from "@/lib/settings";
import { parseId, reportSchema } from "@/lib/validate";

export const POST = route(
  async (req, ctx: { params: Promise<{ id: string }> }) => {
    const caller = await authenticate(req);
    assertWritable();
    const id = parseId((await ctx.params).id);
    if (id === undefined)
      throw new ApiError(
        404,
        "no_such_message",
        "There is no message with that id.",
      );
    const input = await readJson(req, reportSchema);
    const r = await reportMessage(caller, id, input, hashIp(clientIp(req)));
    return json({ reported: true, note: reportNote(r.already) });
  },
);
