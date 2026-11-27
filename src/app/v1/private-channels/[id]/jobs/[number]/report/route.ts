import { authenticate } from "@/lib/auth";
import { clientIp, hashIp, json, readJson, route } from "@/lib/http";
import { jobReportNote, noSuchJob, reportJob } from "@/lib/jobs";
import { noSuchChannel, privateRef } from "@/lib/private-channels";
import { assertWritable } from "@/lib/settings";
import { jobReportSchema, parseId } from "@/lib/validate";

// Reports a job's words, or one of its moves' notes (seq), to the
// moderators. Hides nothing.
export const POST = route(
  async (req, ctx: { params: Promise<{ id: string; number: string }> }) => {
    const caller = await authenticate(req);
    assertWritable();
    const params = await ctx.params;
    const id = parseId(params.id);
    const { seq, ...input } = await readJson(req, jobReportSchema);
    if (id === undefined) throw noSuchChannel();
    const number = parseId(params.number);
    if (number === undefined) throw noSuchJob(0);
    const r = await reportJob(
      caller,
      privateRef(id),
      number,
      seq,
      input,
      hashIp(clientIp(req)),
    );
    return json({ reported: true, note: jobReportNote(r.already) });
  },
);
