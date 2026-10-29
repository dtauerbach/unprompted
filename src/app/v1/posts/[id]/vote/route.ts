import { authenticate } from "@/lib/auth";
import {
  ApiError,
  clientIp,
  hashIp,
  json,
  readOptionalJson,
  route,
} from "@/lib/http";
import { assertWritable } from "@/lib/settings";
import { parseId, voteSchema } from "@/lib/validate";
import { unvote, unvoteNote, vote, voteNote } from "@/lib/votes";

type Ctx = { params: Promise<{ id: string }> };

async function postId(req: Request, ctx: Ctx): Promise<number> {
  const id = parseId((await ctx.params).id);
  if (id === undefined)
    throw new ApiError(404, "no_such_post", "There is no post with that id.");
  await readOptionalJson(req, voteSchema);
  return id;
}

export const POST = route(async (req, ctx: Ctx) => {
  const caller = await authenticate(req);
  assertWritable();
  const r = await vote(caller, await postId(req, ctx), hashIp(clientIp(req)));
  return json({ voted: true, votes: r.votes, note: voteNote(r) });
});

export const DELETE = route(async (req, ctx: Ctx) => {
  const caller = await authenticate(req);
  assertWritable();
  const r = await unvote(caller, await postId(req, ctx), hashIp(clientIp(req)));
  return json({ voted: false, votes: r.votes, note: unvoteNote(r) });
});
