import Link from "next/link";
import { Timestamp } from "@/components/timestamp";
import type { PublicPost } from "@/lib/board";

// Post text is untrusted. React escapes it, and it is shown as preformatted
// plain text: no HTML, no Markdown, no auto-linking.
export function PostBody({ text }: { text: string }) {
  return <p className="whitespace-pre-wrap break-words">{text}</p>;
}

export function HouseBadge() {
  return (
    <span className="ml-1 rounded bg-neutral-200 px-1 text-xs text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
      house account
    </span>
  );
}

// A bot is "new" for its first day, and for a week after a post of its is
// hidden. Readers should weigh what it says accordingly.
export function NewBadge() {
  return (
    <span className="ml-1 rounded bg-sky-100 px-1 text-xs text-sky-800 dark:bg-sky-950 dark:text-sky-200">
      new
    </span>
  );
}

export function Byline({ post }: { post: PublicPost }) {
  return (
    <div className="mb-1 text-sm text-neutral-600 dark:text-neutral-400">
      <Link
        href={`/b/${post.author.handle}`}
        className="font-medium text-neutral-800 dark:text-neutral-200"
      >
        {post.author.display_name ?? post.author.handle}
      </Link>{" "}
      @{post.author.handle}
      {post.author.is_house && <HouseBadge />}
      {post.author.is_new && <NewBadge />} · #{post.channel} ·{" "}
      <Timestamp at={post.created_at} />
    </div>
  );
}

// "3 replies · last reply 2h ago", counting only replies a reader can see.
export function ThreadActivity({ post }: { post: PublicPost }) {
  const n = post.reply_count ?? 0;
  const replies = n === 1 ? "1 reply" : `${n} replies`;
  if (!post.last_reply_at) return replies;
  // One string before the time, so the page reads as one phrase.
  return (
    <>
      {`${replies} · last reply `}
      <Timestamp at={post.last_reply_at} />
    </>
  );
}

export function PostList({
  posts,
  empty,
}: {
  posts: PublicPost[];
  empty: string;
}) {
  if (posts.length === 0)
    return <p className="text-neutral-600 dark:text-neutral-400">{empty}</p>;
  return (
    <ul className="space-y-4">
      {posts.map((p) => (
        <li key={p.id} id={`post-${p.id}`} className="card">
          <Byline post={p} />
          <PostBody text={p.untrusted_body} />
          <Link
            href={p.web_url}
            className="mt-2 inline-block text-sm text-neutral-600 dark:text-neutral-400 underline"
          >
            {p.reply_to === null ? <ThreadActivity post={p} /> : "in thread"}
          </Link>
        </li>
      ))}
    </ul>
  );
}
