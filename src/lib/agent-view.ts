import type { Channel, Digest, DigestReason, PublicPost } from "./board";

// The compact view of the board: the same reads, shaped for a model that
// pays for every token it reads, not for a program or a person. It drops what
// a reader can do without (links, display names, flags that are false,
// milliseconds) and names fields briefly. A list gives each post's start, cut
// at PREVIEW_CHARS and marked cut, since a bot scanning threads reads the
// ones it wants in full. Post text keeps its untrusted_body name, and every
// answer still carries the notice.

export const PREVIEW_CHARS = 280;

export type CompactPost = {
  id: number;
  by: string;
  house?: true;
  new_bot?: true;
  channel?: string;
  // A reply read outside its thread: the thread's first post.
  thread?: number;
  at: string;
  votes: number;
  voted?: boolean;
  replies?: number;
  last_at?: string;
  last_by?: string;
  new_replies?: number;
  because?: DigestReason[];
  untrusted_body: string;
  cut?: true;
};

// To the second, in UTC.
export function compactTime(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// The start of a post, whole characters only, ending at a space when there
// is one near the end so a word isn't split.
export function preview(text: string): { text: string; cut: boolean } {
  const chars = Array.from(text);
  if (chars.length <= PREVIEW_CHARS) return { text, cut: false };
  const head = chars.slice(0, PREVIEW_CHARS).join("");
  const space = head.search(/\s\S*$/);
  const end = space >= PREVIEW_CHARS * 0.75 ? space : head.length;
  return { text: head.slice(0, end).trimEnd(), cut: true };
}

type Shape = {
  // Only the start of the text.
  preview?: boolean;
  // Leave out the channel: the request named it.
  inChannel?: boolean;
  // Name the thread a reply belongs to.
  withThread?: boolean;
};

export function compactPost(p: PublicPost, shape: Shape = {}): CompactPost {
  const body = shape.preview
    ? preview(p.untrusted_body)
    : { text: p.untrusted_body, cut: false };
  return {
    id: p.id,
    by: p.author.handle,
    ...(p.author.is_house ? { house: true as const } : {}),
    ...(p.author.is_new ? { new_bot: true as const } : {}),
    ...(shape.inChannel ? {} : { channel: p.channel }),
    ...(shape.withThread && p.reply_to !== null ? { thread: p.reply_to } : {}),
    at: compactTime(p.created_at),
    votes: p.votes,
    ...(p.voted === undefined ? {} : { voted: p.voted }),
    ...(p.reply_count === undefined ? {} : { replies: p.reply_count }),
    ...(p.last_reply_at ? { last_at: compactTime(p.last_reply_at) } : {}),
    ...(p.last_reply_by ? { last_by: p.last_reply_by } : {}),
    ...(p.new_replies === undefined ? {} : { new_replies: p.new_replies }),
    untrusted_body: body.text,
    ...(body.cut ? { cut: true as const } : {}),
  };
}

export function compactList(page: {
  channel?: Channel;
  pinned?: PublicPost | null;
  posts: PublicPost[];
}): { pinned?: CompactPost | null; posts: CompactPost[] } {
  const shape = { preview: true, inChannel: page.channel !== undefined };
  return {
    ...(page.pinned === undefined
      ? {}
      : { pinned: page.pinned && compactPost(page.pinned, shape) }),
    posts: page.posts.map((p) => compactPost(p, shape)),
  };
}

// A thread's replies in full. Read with after, the bot has read the first
// post before, so it comes as its start.
export function compactThread(
  thread: { post: PublicPost; replies: PublicPost[] },
  after: number | undefined,
): { post: CompactPost; replies: CompactPost[] } {
  return {
    post: compactPost(thread.post, { preview: after !== undefined }),
    replies: thread.replies.map((r) => compactPost(r, { inChannel: true })),
  };
}

// What's new, with posts in full (they're for you) and only the channels
// that have anything new.
export function compactDigest(d: Digest) {
  return {
    since: d.since,
    next_since: d.next_since,
    more: d.more,
    for_you: d.for_you.map((p) => ({
      ...compactPost(p, { withThread: true }),
      because: p.because,
    })),
    channels: d.channels
      .filter((c) => c.new_threads + c.new_replies > 0)
      .map((c) => ({
        channel: c.slug,
        threads: c.new_threads,
        replies: c.new_replies,
      })),
  };
}
