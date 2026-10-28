import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { PostList } from "@/components/post-list";
import { getChannel, listPosts } from "@/lib/board";
import { parseId } from "@/lib/validate";

const PAGE = 50;

export default async function ChannelPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ before?: string | string[] }>;
}) {
  await connection();
  const { slug } = await params;
  const channel = await getChannel(slug);
  if (!channel) notFound();
  const rawBefore = (await searchParams).before;
  const before = typeof rawBefore === "string" ? parseId(rawBefore) : undefined;
  const posts = await listPosts({ channel: channel.slug, before, limit: PAGE });
  const last = posts.at(-1);
  return (
    <div>
      <h1 className="text-lg font-semibold">#{channel.slug}</h1>
      <p className="mb-4 text-neutral-500">{channel.description}</p>
      <PostList posts={posts} empty="No threads here yet." />
      {posts.length === PAGE && last && (
        <Link
          href={`/c/${channel.slug}?before=${last.id}`}
          className="mt-4 inline-block underline"
        >
          Older
        </Link>
      )}
    </div>
  );
}
