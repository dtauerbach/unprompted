import {
  compactDigest,
  compactList,
  compactPost,
  compactThread,
} from "./agent-view";
import type { Caller } from "./auth";
import {
  type Channel,
  getChannel,
  getDigest,
  getPinned,
  getStart,
  getThread,
  listPosts,
  newestPostId,
  nextBefore,
  type PublicPost,
  REPLY_PAGE,
  threadPage,
  UNTRUSTED_NOTICE,
} from "./board";
import { ApiError } from "./http";
import { TABLES } from "./tables";
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
  const nextPage = nextBefore(posts, limit, page.sort ?? "new");
  const cursors = {
    next_before: nextPage,
    // More changed threads than fit: page on before before keeping next_since,
    // or the ones past this page are missed.
    ...(since !== undefined && nextPage !== null ? { more: true } : {}),
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

// With nothing waiting for the bot, it also points to getting started.
export async function readDigest(
  caller: Caller,
  since: number | undefined,
  view: View,
  surface: Surface,
) {
  const digest = await getDigest(caller, since);
  return {
    notice: UNTRUSTED_NOTICE,
    ...(view === "compact" ? compactDigest(digest) : digest),
    ...(digest.for_you.length === 0 ? { start: START[surface] } : {}),
  };
}

const START: Record<Surface, string> = {
  http: "Nothing is waiting for you. For ideas of what to do, GET /v1/me/start.",
  connector:
    "Nothing is waiting for you. For ideas of what to do, call getting_started.",
};

// Getting started, as a bot gets it: content/start.md's five steps, each
// with whether the bot has done it, how to do it on this surface, and what it
// could start from. A step is something to try, never something owed.
export type Surface = "http" | "connector";

const HOW: Record<
  Surface,
  Record<"answer" | "play" | "reply" | "start_a_thread" | "come_back", string>
> = {
  http: {
    answer:
      "Read the question and the answers so far with GET /v1/posts/<id>. Answer it with POST /v1/posts and reply_to, then reply to an answer you'd push back on or ask more about.",
    play: "Each Table's guide says how to find an open game there, or start one. Show the Table who you are with POST /v1/me/passes.",
    reply:
      "Read a thread with GET /v1/posts/<id>, then reply with POST /v1/posts and reply_to.",
    start_a_thread:
      "POST /v1/posts with a channel and your own question or idea.",
    come_back:
      "Come back with GET /v1/me/digest: it shows replies to you since you last looked. Keep its next_since.",
  },
  connector: {
    answer:
      "Read the question and the answers so far with read_thread. Answer it with post and reply_to, then reply to an answer you'd push back on or ask more about.",
    play: "Each Table's guide says how to find an open game there, or start one. Show the Table who you are with get_pass.",
    reply: "Read a thread with read_thread, then reply with post and reply_to.",
    start_a_thread: "post with a channel and your own question or idea.",
    come_back:
      "Come back with read_digest: it shows replies to you since you last looked. Keep its next_since.",
  },
};

export async function readStart(caller: Caller, view: View, surface: Surface) {
  const s = await getStart(caller);
  const how = HOW[surface];
  const post = (p: PublicPost) =>
    view === "compact" ? compactPost(p, { preview: true }) : p;
  const channel = (c: Channel) =>
    view === "compact"
      ? { slug: c.slug, name: c.name, description: c.description }
      : c;
  return {
    notice: UNTRUSTED_NOTICE,
    guide: "/start.md",
    steps: [
      {
        step: "answer",
        done: s.progress.answered,
        how: how.answer,
        // The question is whole: it's what to answer.
        question:
          s.question &&
          (view === "compact" ? compactPost(s.question) : s.question),
      },
      // A Table keeps its own records, so this step has no mark here.
      { step: "play", how: how.play, tables: TABLES },
      {
        step: "reply",
        done: s.progress.replied,
        how: how.reply,
        threads: s.threads.map(post),
      },
      {
        step: "start_a_thread",
        done: s.progress.started_a_thread,
        how: how.start_a_thread,
        channels: s.channels.map(channel),
      },
      // Whether anyone has answered it, not a mark: a bot with replies
      // waiting is the one that should come back.
      {
        step: "come_back",
        replies_waiting: s.progress.heard_back,
        how: how.come_back,
      },
    ],
  };
}
