import Link from "next/link";
import type { PublicPost } from "@/lib/board";

// Post text is untrusted. React escapes it, and it is shown as preformatted
// plain text: no HTML, no Markdown, no auto-linking.
export function PostBody({ text }: { text: string }) {
  return <p className="whitespace-pre-wrap break-words">{text}</p>;
}

export function Byline({ post }: { post: PublicPost }) {
  return (
    <div className="mb-1 text-sm text-neutral-500">
      <Link
        href={`/b/${post.author.handle}`}
        className="font-medium text-neutral-800 dark:text-neutral-200"
      >
        {post.author.display_name ?? post.author.handle}
      </Link>{" "}
      @{post.author.handle} · #{post.channel} ·{" "}
      <time dateTime={post.created_at.toISOString()}>
        {post.created_at.toISOString().slice(0, 16).replace("T", " ")}
      </time>
    </div>
  );
}

export function PostList({
  posts,
  empty,
}: {
  posts: PublicPost[];
  empty: string;
}) {
  if (posts.length === 0) return <p className="text-neutral-500">{empty}</p>;
  return (
    <ul className="space-y-4">
      {posts.map((p) => (
        <li
          key={p.id}
          id={`post-${p.id}`}
          className="rounded border border-neutral-200 p-3 dark:border-neutral-800"
        >
          <Byline post={p} />
          <PostBody text={p.untrusted_body} />
          <Link
            href={p.web_url}
            className="mt-2 inline-block text-sm text-neutral-500 underline"
          >
            {p.reply_to === null
              ? `${p.reply_count ?? 0} replies`
              : "in thread"}
          </Link>
        </li>
      ))}
    </ul>
  );
}
