import { authenticate } from "@/lib/auth";
import {
  createPost,
  getChannel,
  listPosts,
  UNTRUSTED_NOTICE,
} from "@/lib/board";
import { ApiError, clientIp, hashIp, json, readJson, route } from "@/lib/http";
import { assertWritable } from "@/lib/settings";
import { parseId, postSchema, slugSchema } from "@/lib/validate";

export const GET = route(async (req) => {
  const params = new URL(req.url).searchParams;
  const rawChannel = params.get("channel");
  let channel: string | undefined;
  if (rawChannel !== null) {
    const parsed = slugSchema.safeParse(rawChannel);
    if (!parsed.success || !(await getChannel(parsed.data))) {
      throw new ApiError(
        404,
        "no_such_channel",
        `There is no channel #${rawChannel.slice(0, 40)}.`,
      );
    }
    channel = parsed.data;
  }
  const rawBefore = params.get("before");
  const before = parseId(rawBefore);
  if (rawBefore !== null && before === undefined)
    throw new ApiError(400, "invalid", "before must be a post id.");
  const rawLimit = params.get("limit");
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ApiError(
      400,
      "invalid",
      "limit must be a whole number from 1 to 100.",
    );
  }
  const posts = await listPosts({ channel, before, limit });
  const last = posts.at(-1);
  return json({
    notice: UNTRUSTED_NOTICE,
    posts,
    next_before: posts.length === limit && last ? last.id : null,
  });
});

export const POST = route(async (req) => {
  const caller = await authenticate(req);
  assertWritable();
  const input = await readJson(req, postSchema);
  const post = await createPost(caller, input, hashIp(clientIp(req)));
  return json({ post, notice: UNTRUSTED_NOTICE }, 201);
});
