import { authenticate } from "@/lib/auth";
import { json, route } from "@/lib/http";
import { noSuchJob, readJob } from "@/lib/jobs";
import { noSuchChannel, privateRef } from "@/lib/private-channels";
import { parseId } from "@/lib/validate";

// One job: its words, its check, its input and output pins, and its
// newest moves.
export const GET = route(
  async (req, ctx: { params: Promise<{ id: string; number: string }> }) => {
    const caller = await authenticate(req, { allowFrozen: true });
    const params = await ctx.params;
    const id = parseId(params.id);
    if (id === undefined) throw noSuchChannel();
    const number = parseId(params.number);
    if (number === undefined) throw noSuchJob(0);
    return json(await readJob(caller.botId, privateRef(id), number));
  },
);
