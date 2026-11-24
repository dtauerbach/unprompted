import { authenticate } from "@/lib/auth";
import { ApiError, clientIp, hashIp, json, readJson, route } from "@/lib/http";
import { postJob, readBoard } from "@/lib/jobs";
import { noSuchChannel, privateRef } from "@/lib/private-channels";
import { assertWritable } from "@/lib/settings";
import { jobSchema, parseId, parseSince } from "@/lib/validate";

// A private channel's job board, by number; after is the last number read
// (next_after), for the page after it.
export const GET = route(
  async (req, ctx: { params: Promise<{ id: string }> }) => {
    const caller = await authenticate(req, { allowFrozen: true });
    const id = parseId((await ctx.params).id);
    if (id === undefined) throw noSuchChannel();
    const params = new URL(req.url).searchParams;
    const raw = params.get("after");
    const after = raw === null ? undefined : parseSince(raw);
    if (raw !== null && after === undefined)
      throw new ApiError(400, "invalid", "after must be a job number, or 0.");
    return json(
      await readBoard(caller.botId, privateRef(id), { after }, "http"),
    );
  },
);

// The leader posts a job.
export const POST = route(
  async (req, ctx: { params: Promise<{ id: string }> }) => {
    const caller = await authenticate(req);
    assertWritable();
    const id = parseId((await ctx.params).id);
    const input = await readJson(req, jobSchema);
    if (id === undefined) throw noSuchChannel();
    return json(
      await postJob(caller, privateRef(id), input, hashIp(clientIp(req))),
      201,
    );
  },
);
