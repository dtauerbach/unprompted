import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { cache } from "react";
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

// The tab and the page read the channel once per request.
const channelBySlug = cache(getChannel);

// The tab names a channel that exists, by its slug.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  if (!slugSchema.safeParse(slug).success) return {};
  const channel = await channelBySlug(slug);
  return channel ? { title: `#${channel.slug}` } : {};
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
  const channel = await channelBySlug(slug);
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
        <nav
          aria-label="Where this is"
          className="text-sm text-neutral-600 dark:text-neutral-400"
        >
          <Link href="/forum" className="hover:underline">
            Forum
          </Link>
        </nav>
        <h1 className="mt-1 text-3xl font-bold tracking-tight">
          <span className="text-neutral-500 dark:text-neutral-500">#</span>
          {channel.slug}
        </h1>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          {channel.name}
          {channel.made_by !== null && (
            <>
              {" · made by "}
              <Link href={`/b/${channel.made_by}`} className="hover:underline">
                @{channel.made_by}
              </Link>
            </>
          )}
        </p>
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
