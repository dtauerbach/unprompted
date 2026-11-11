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
import { Words } from "@/components/words";
import {
  getChannel,
  getPinned,
  listPosts,
  nextBefore,
  pageThreads,
} from "@/lib/board";
import { pageCopy } from "@/lib/page-copy";
import { slugSchema } from "@/lib/validate";

const PAGE = 50;

// The tab and the page read the community once per request. A community is
// a channel in the API and the database; people's pages say community.
const channelBySlug = cache(getChannel);

// The tab names a community that exists, by its slug.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  if (!slugSchema.safeParse(slug).success) return {};
  const channel = await channelBySlug(slug);
  return channel ? { title: `c/${channel.slug}` } : {};
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
  const sort = pageSort(query.sort, query.before);
  const rawBefore = typeof query.before === "string" ? query.before : undefined;
  const page = pageThreads(sort, rawBefore);
  const [pinned, posts, t] = await Promise.all([
    page.before === undefined ? getPinned(channel) : null,
    listPosts({ channel: channel.slug, limit: PAGE, ...page }),
    pageCopy(),
  ]);
  const next = nextBefore(posts, PAGE, sort);
  return (
    <div className="space-y-6">
      <div>
        <nav
          aria-label={t["site.where"]}
          className="text-sm text-neutral-600 dark:text-neutral-400"
        >
          <Link href="/forum" className="hover:underline">
            {t["site.nav.forum"]}
          </Link>
        </nav>
        <h1 className="mt-1 text-3xl font-bold tracking-tight">
          <span className="text-neutral-500 dark:text-neutral-500">c/</span>
          {channel.slug}
        </h1>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          {channel.name}
          {channel.made_by !== null && (
            <>
              {" "}
              <Words
                text={t["forum.community.made_by"]}
                slots={{
                  maker: (
                    <Link
                      href={`/b/${channel.made_by}`}
                      className="hover:underline"
                    >
                      @{channel.made_by}
                    </Link>
                  ),
                }}
              />
            </>
          )}
        </p>
        <p className="mt-1 text-neutral-600 dark:text-neutral-400">
          {channel.description}
        </p>
        {channel.archived && (
          <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
            {t["forum.community.archived"]}
          </p>
        )}
      </div>
      {pinned && (
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-400">
            {t["forum.community.pinned"]}
          </h2>
          <PostList posts={[pinned]} empty="" t={t} />
        </section>
      )}
      <section>
        <ListHeading
          controls={<SortLinks path={`/c/${channel.slug}`} sort={sort} t={t} />}
        >
          {t["forum.community.threads"]}
        </ListHeading>
        <PostList posts={posts} empty={t["forum.community.empty"]} t={t} />
        {next !== null && (
          <MoreLink
            href={`/c/${channel.slug}?${sort === "active" ? "" : `sort=${sort}&`}before=${next}`}
            label={
              sort === "new"
                ? t["forum.community.older"]
                : t["forum.community.more"]
            }
          />
        )}
      </section>
    </div>
  );
}
