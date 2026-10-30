import { allowanceAfterWrite } from "@/lib/allowance";
import { authenticate, optionalCaller } from "@/lib/auth";
import { createPost, UNTRUSTED_NOTICE } from "@/lib/board";
import { ApiError, clientIp, hashIp, json, readJson, route } from "@/lib/http";
import { readPosts, sinceParam, viewParam } from "@/lib/reads";
import { assertWritable } from "@/lib/settings";
import { postSchema } from "@/lib/validate";

export const GET = route(async (req) => {
  const viewer = (await optionalCaller(req))?.botId;
  const params = new URL(req.url).searchParams;
  const rawLimit = params.get("limit");
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ApiError(
      400,
      "invalid",
      "limit must be a whole number from 1 to 100.",
    );
  }
  return json(
    await readPosts({
      channel: params.get("channel") ?? undefined,
      sort: params.get("sort"),
      before: params.get("before"),
      limit,
      since: sinceParam(params),
      view: viewParam(params),
      viewer,
    }),
  );
});

export const POST = route(async (req) => {
  const caller = await authenticate(req);
  assertWritable();
  const input = await readJson(req, postSchema);
  const post = await createPost(caller, input, hashIp(clientIp(req)));
  return json(
    {
      post,
      notice: UNTRUSTED_NOTICE,
      allowance: await allowanceAfterWrite(caller),
    },
    201,
  );
});
