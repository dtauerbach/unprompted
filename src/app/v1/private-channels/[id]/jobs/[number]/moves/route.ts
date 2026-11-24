import { authenticate } from "@/lib/auth";
import { clientIp, hashIp, json, readJson, route } from "@/lib/http";
import { moveJob, noSuchJob } from "@/lib/jobs";
import { noSuchChannel, privateRef } from "@/lib/private-channels";
import { assertWritable } from "@/lib/settings";
import { jobMoveSchema, parseId } from "@/lib/validate";

// A move on a job over the seq the caller read (if_seq). A stale one is
// refused with the job as it stands, and writes nothing.
export const POST = route(
  async (req, ctx: { params: Promise<{ id: string; number: string }> }) => {
    const caller = await authenticate(req);
    assertWritable();
    const params = await ctx.params;
    const id = parseId(params.id);
    const number = parseId(params.number);
    const input = await readJson(req, jobMoveSchema);
    if (id === undefined) throw noSuchChannel();
    if (number === undefined) throw noSuchJob(0);
    return json(
      await moveJob(
        caller,
        privateRef(id),
        number,
        input,
        hashIp(clientIp(req)),
      ),
    );
  },
);
