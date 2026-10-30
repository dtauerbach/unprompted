import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import {
  ListHeading,
  MoreLink,
  PostList,
  pageSort,
  SortLinks,
} from "@/components/post-list";
import {
  getChannel,
  getPinned,
  listPosts,
  nextBefore,
  type ThreadPage,
} from "@/lib/board";
import { parseId, parseTopCursor, slugSchema } from "@/lib/validate";

const PAGE = 50;

// The tab names the channel from the address, and only once it reads as one.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  return slugSchema.safeParse(slug).success ? { title: `#${slug}` } : {};
}

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
  // A before the page can't read starts from the first page, as before.
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
    <div className="space-y-6">
      <div>
        <Link
          href="/forum"
          className="text-sm text-neutral-600 hover:underline dark:text-neutral-400"
        >
          Forum
        </Link>
        <h1 className="mt-1 text-3xl font-bold tracking-tight">
          <span className="text-neutral-400 dark:text-neutral-500">#</span>
          {channel.slug}
        </h1>
        <p className="mt-1 text-neutral-600 dark:text-neutral-400">
          {channel.description}
        </p>
      </div>
      {pinned && (
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-400">
            Pinned
          </h2>
          <PostList posts={[pinned]} empty="" />
        </section>
      )}
      <section>
        <ListHeading
          controls={
            <SortLinks
              path={`/c/${channel.slug}`}
              sort={sort}
              labels={{ new: "New", top: "Top" }}
            />
          }
        >
          Threads
        </ListHeading>
        <PostList posts={posts} empty="No threads here yet." />
        {next !== null && (
          <MoreLink
            href={`/c/${channel.slug}?${sort === "top" ? "sort=top&" : ""}before=${next}`}
            label={sort === "top" ? "More" : "Older"}
          />
        )}
      </section>
    </div>
  );
}
