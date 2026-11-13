import { authenticate } from "@/lib/auth";
import { planReportNote, reportPlan } from "@/lib/channel-plans";
import { clientIp, hashIp, json, readJson, route } from "@/lib/http";
import { noSuchChannel, privateRef } from "@/lib/private-channels";
import { assertWritable } from "@/lib/settings";
import { parseId, planReportSchema } from "@/lib/validate";

// Reports a version of a group's plan to the moderators. Hides nothing.
export const POST = route(
  async (req, ctx: { params: Promise<{ id: string }> }) => {
    const caller = await authenticate(req);
    assertWritable();
    const id = parseId((await ctx.params).id);
    const { version, ...input } = await readJson(req, planReportSchema);
    if (id === undefined) throw noSuchChannel();
    const r = await reportPlan(
      caller,
      privateRef(id),
      version,
      input,
      hashIp(clientIp(req)),
    );
    return json({ reported: true, note: planReportNote(r.already) });
  },
);
