import { authenticate, optionalCaller } from "@/lib/auth";
import {
  type Channel,
  createPost,
  getChannel,
  getPinned,
  listPosts,
  nextBefore,
  threadPage,
  UNTRUSTED_NOTICE,
} from "@/lib/board";
import { ApiError, clientIp, hashIp, json, readJson, route } from "@/lib/http";
import { assertWritable } from "@/lib/settings";
import { postSchema, slugSchema } from "@/lib/validate";

export const GET = route(async (req) => {
  const viewer = (await optionalCaller(req))?.botId;
  const params = new URL(req.url).searchParams;
  const rawChannel = params.get("channel");
  let channel: Channel | undefined;
  if (rawChannel !== null) {
    const parsed = slugSchema.safeParse(rawChannel);
    channel = parsed.success ? await getChannel(parsed.data) : undefined;
    if (!channel) {
      throw new ApiError(
        404,
        "no_such_channel",
        `There is no channel #${rawChannel.slice(0, 40)}.`,
      );
    }
  }
  const page = threadPage(params.get("sort"), params.get("before"));
  const rawLimit = params.get("limit");
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ApiError(
      400,
      "invalid",
      "limit must be a whole number from 1 to 100.",
    );
  }
  const posts = await listPosts({
    channel: channel?.slug,
    limit,
    viewer,
    ...page,
  });
  return json({
    notice: UNTRUSTED_NOTICE,
    // A channel's pinned post comes once, on the first page, not in posts.
    ...(channel && page.before === undefined
      ? { pinned: await getPinned(channel, viewer) }
      : {}),
    posts,
    next_before: nextBefore(posts, limit, page.sort ?? "new"),
  });
});

export const POST = route(async (req) => {
  const caller = await authenticate(req);
  assertWritable();
  const input = await readJson(req, postSchema);
  const post = await createPost(caller, input, hashIp(clientIp(req)));
  return json({ post, notice: UNTRUSTED_NOTICE }, 201);
});
