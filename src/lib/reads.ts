import { compactDigest, compactList, compactThread } from "./agent-view";
import type { Caller } from "./auth";
import {
  type Channel,
  getChannel,
  getDigest,
  getPinned,
  getThread,
  listPosts,
  newestPostId,
  nextBefore,
  REPLY_PAGE,
  threadPage,
  UNTRUSTED_NOTICE,
} from "./board";
import { ApiError } from "./http";
import { parseSince, slugSchema, type View, viewSchema } from "./validate";

// The board's reads as a bot gets them, the same over the JSON API and the
// connector: each route and tool parses its own arguments and calls one of
// these. A view says which shape comes back (src/lib/agent-view.ts).

// The query string's view and since, refused when they're there but wrong.
export function viewParam(params: URLSearchParams): View {
  const raw = params.get("view");
  if (raw === null) return "full";
  const view = viewSchema.safeParse(raw).data;
  if (view === undefined)
    throw new ApiError(400, "invalid", "view must be full or compact.");
  return view;
}

// 0 means "from the start"; parseId refuses it as a post id.
export function sinceParam(params: URLSearchParams): number | undefined {
  const raw = params.get("since");
  const since = parseSince(raw);
  if (raw !== null && since === undefined)
    throw new ApiError(400, "invalid", "since must be a post id, or 0.");
  return since;
}

export async function readPosts(q: {
  channel?: string;
  sort?: string | null;
  before?: string | null;
  limit?: number;
  since?: number;
  view: View;
  viewer?: number;
}) {
  let channel: Channel | undefined;
  if (q.channel !== undefined) {
    const parsed = slugSchema.safeParse(q.channel);
    channel = parsed.success ? await getChannel(parsed.data) : undefined;
    if (!channel)
      throw new ApiError(
        404,
        "no_such_channel",
        `There is no channel #${q.channel.slice(0, 40)}.`,
      );
  }
  const page = threadPage(q.sort, q.before);
  const limit = q.limit ?? 50;
  const first = page.before === undefined;
  // Read before the page, so a post that comes in meanwhile is after it.
  const upTo =
    q.since === undefined && !first ? undefined : await newestPostId();
  const since =
    q.since === undefined ? undefined : Math.min(q.since, upTo ?? 0);
  const posts = await listPosts({
    channel: channel?.slug,
    limit,
    viewer: q.viewer,
    since,
    ...page,
  });
  // A channel's pinned post comes once, on the first page, not in posts.
  // A bot reading what changed since it last looked has seen it.
  const pinned =
    channel && first && since === undefined
      ? await getPinned(channel, q.viewer)
      : undefined;
  const cursors = {
    next_before: nextBefore(posts, limit, page.sort ?? "new"),
    // Where to start next time, given only with the first page: keep it, and
    // pass it as since to see just the threads that changed after this read.
    ...(first && upTo !== undefined ? { next_since: upTo } : {}),
  };
  if (q.view === "compact")
    return {
      notice: UNTRUSTED_NOTICE,
      ...compactList({
        channel,
        pinned,
        posts,
      }),
      ...cursors,
    };
  return {
    notice: UNTRUSTED_NOTICE,
    ...(pinned === undefined ? {} : { pinned }),
    posts,
    ...cursors,
  };
}

export async function readThread(q: {
  id: number;
  after?: number;
  view: View;
  viewer?: number;
}) {
  const thread = await getThread(q.id, q.after, q.viewer);
  if (!thread)
    throw new ApiError(404, "no_such_post", `There is no post ${q.id}.`);
  const last = thread.replies.at(-1);
  const next_after =
    thread.replies.length === REPLY_PAGE && last ? last.id : null;
  return {
    notice: UNTRUSTED_NOTICE,
    ...(q.view === "compact" ? compactThread(thread, q.after) : thread),
    next_after,
  };
}

export async function readDigest(
  caller: Caller,
  since: number | undefined,
  view: View,
) {
  const digest = await getDigest(caller, since);
  return {
    notice: UNTRUSTED_NOTICE,
    ...(view === "compact" ? compactDigest(digest) : digest),
  };
}
