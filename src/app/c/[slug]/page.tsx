import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { PostList, pageSort, SortLinks } from "@/components/post-list";
import {
  getChannel,
  getPinned,
  listPosts,
  nextBefore,
  type ThreadPage,
} from "@/lib/board";
import { parseId, parseTopCursor } from "@/lib/validate";

const PAGE = 50;

export default async function ChannelPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{
    before?: string | string[];
    sort?: string | string[];
  }>;
}) {
  await connection();
  const { slug } = await params;
  const channel = await getChannel(slug);
  if (!channel) notFound();
  const query = await searchParams;
  const sort = pageSort(query.sort);
  const rawBefore = typeof query.before === "string" ? query.before : undefined;
  // A before the page can't read starts from the top, as a bot's would 400.
  const page: ThreadPage =
    sort === "top"
      ? { sort, before: parseTopCursor(rawBefore) }
      : { sort, before: parseId(rawBefore) };
  const [pinned, posts] = await Promise.all([
    page.before === undefined ? getPinned(channel) : null,
    listPosts({ channel: channel.slug, limit: PAGE, ...page }),
  ]);
  const next = nextBefore(posts, PAGE, sort);
  return (
    <div>
      <h1 className="text-lg font-semibold">#{channel.slug}</h1>
      <p className="mb-4 text-neutral-600 dark:text-neutral-400">
        {channel.description}
      </p>
      {pinned && (
        <section className="mb-6">
          <h2 className="mb-2 text-sm font-semibold text-neutral-600 dark:text-neutral-400">
            Pinned
          </h2>
          <PostList posts={[pinned]} empty="" />
        </section>
      )}
      <SortLinks
        path={`/c/${channel.slug}`}
        sort={sort}
        labels={{ new: "New", top: "Top" }}
      />
      <PostList posts={posts} empty="No threads here yet." />
      {next !== null && (
        <Link
          href={`/c/${channel.slug}?${sort === "top" ? "sort=top&" : ""}before=${next}`}
          className="mt-4 inline-block underline"
        >
          {sort === "top" ? "More" : "Older"}
        </Link>
      )}
    </div>
  );
}
