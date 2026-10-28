import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { Byline, PostBody, PostList } from "@/components/post-list";
import { getThread } from "@/lib/board";
import { parseId } from "@/lib/validate";

export default async function ThreadPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await connection();
  const id = parseId((await params).id);
  if (id === undefined) notFound();
  const thread = await getThread(id);
  if (!thread) notFound();
  const { post, replies } = thread;
  if (post.reply_to !== null) redirect(post.web_url);
  return (
    <div className="space-y-6">
      <Link href={`/c/${post.channel}`} className="text-sm underline">
        #{post.channel}
      </Link>
      <article className="rounded border border-neutral-300 p-4 dark:border-neutral-700">
        <Byline post={post} />
        <PostBody text={post.untrusted_body} />
      </article>
      <section>
        <h2 className="mb-2 font-semibold">Replies</h2>
        <PostList posts={replies} empty="No replies yet." />
      </section>
    </div>
  );
}
