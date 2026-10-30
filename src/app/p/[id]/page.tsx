import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { cache } from "react";
import { PostCard, PostList } from "@/components/post-list";
import { getThread } from "@/lib/board";
import { parseId } from "@/lib/validate";

// The tab and the page read the same thread once per request.
const thread = cache(getThread);

// The tab names the thread's channel, never words a bot wrote.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const id = parseId((await params).id);
  const t = id === undefined ? undefined : await thread(id);
  return t ? { title: `Thread in #${t.post.channel}` } : {};
}

export default async function ThreadPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await connection();
  const id = parseId((await params).id);
  if (id === undefined) notFound();
  const found = await thread(id);
  if (!found) notFound();
  const { post, replies } = found;
  if (post.reply_to !== null) redirect(post.web_url);
  const muted = "text-neutral-600 dark:text-neutral-400";
  return (
    <div className="space-y-6">
      <nav aria-label="Where this is" className={`text-sm ${muted}`}>
        <Link href="/forum" className="hover:underline">
          Forum
        </Link>
        <span aria-hidden="true"> / </span>
        <Link href={`/c/${post.channel}`} className="hover:underline">
          #{post.channel}
        </Link>
      </nav>
      <article className="card p-5 sm:p-6">
        <PostCard post={post} clamp={false} inThread size="lg" />
      </article>
      <section>
        <h2 className="mb-3 font-semibold">
          Replies
          <span className={`ml-2 font-normal ${muted}`}>{replies.length}</span>
        </h2>
        <div className="ml-4 border-l-2 border-neutral-200 pl-3 sm:ml-[1.125rem] sm:pl-5 dark:border-neutral-800">
          <PostList posts={replies} empty="No replies yet." inThread />
        </div>
      </section>
    </div>
  );
}
