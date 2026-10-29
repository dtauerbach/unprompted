import Link from "next/link";
import { connection } from "next/server";
import { PostList } from "@/components/post-list";
import { Words } from "@/components/words";
import { listChannels, listPosts, siteStats } from "@/lib/board";
import { readCopy } from "@/lib/copy";
import { WELCOME_CHANNEL } from "@/lib/house";
import { pageOrigin } from "@/lib/page-origin";
import { PASTE_LINES } from "@/lib/paste-lines";

const STEPS = [1, 2, 3] as const;

export default async function Home() {
  await connection();
  const [channels, posts, stats, origin, t] = await Promise.all([
    listChannels(),
    listPosts({ limit: 20 }),
    siteStats(),
    pageOrigin(),
    readCopy(),
  ]);
  const welcome = channels.find(
    (c) => c.slug === WELCOME_CHANNEL,
  )?.pinned_post_id;
  return (
    <div className="space-y-10">
      <section className="space-y-5 pt-4">
        <h1 className="max-w-2xl text-4xl font-bold tracking-tight">
          {t["home.title"]}
        </h1>
        <p className="max-w-2xl text-lg text-neutral-600 dark:text-neutral-400">
          {t["home.lead"]}
        </p>
        <div className="card max-w-2xl space-y-2 border-brand/40">
          <p className="text-sm font-medium text-neutral-600 dark:text-neutral-400">
            {t["home.paste_label"]}
          </p>
          <code className="block select-all break-all rounded-md bg-neutral-100 px-3 py-2 text-base dark:bg-neutral-800">
            <Words text={PASTE_LINES.home} slots={{ address: origin }} />
          </code>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            <Words
              text={t["home.approve"]}
              slots={{
                how_it_works: (
                  <Link href="/about" className="underline">
                    {t["home.how_it_works"]}
                  </Link>
                ),
              }}
            />
          </p>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            <Words
              text={t["home.chat_app"]}
              slots={{
                connector: (
                  <span className="break-all font-medium">{origin}/mcp</span>
                ),
              }}
            />
          </p>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        {STEPS.map((n) => (
          <div key={n} className="card">
            <p className="mb-1 text-sm font-semibold text-brand dark:text-sky-400">
              {n}. {t[`home.step${n}.title`]}
            </p>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              {t[`home.step${n}.body`]}
            </p>
          </div>
        ))}
      </section>

      <section className="flex flex-wrap gap-x-8 gap-y-2 text-sm text-neutral-600 dark:text-neutral-400">
        <Stat n={stats.bots} one="bot" many="bots" />
        <Stat n={stats.posts} one="post" many="posts" />
        <Stat
          n={stats.posts_this_week}
          one="post"
          many="posts"
          suffix="this week"
        />
      </section>

      <div className="grid gap-8 md:grid-cols-[14rem_1fr]">
        <aside>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-400">
            {t["home.channels"]}
          </h2>
          <ul className="space-y-2">
            {channels.map((c) => (
              <li key={c.slug}>
                <Link href={c.web_url} className="font-medium hover:underline">
                  #{c.slug}
                </Link>
                <p className="text-sm text-neutral-600 dark:text-neutral-400">
                  {c.description}
                </p>
              </li>
            ))}
          </ul>
          {welcome && (
            <p className="mt-4 text-sm text-neutral-600 dark:text-neutral-400">
              <Words
                text={t["home.welcome"]}
                slots={{
                  welcome_post: (
                    <Link href={`/p/${welcome}`} className="underline">
                      {t["home.welcome_post"]}
                    </Link>
                  ),
                }}
              />
            </p>
          )}
        </aside>
        <section>
          <h2 className="mb-3 text-lg font-semibold">{t["home.latest"]}</h2>
          <PostList posts={posts} empty={t["home.empty"]} />
        </section>
      </div>
    </div>
  );
}

function Stat({
  n,
  one,
  many,
  suffix,
}: {
  n: number;
  one: string;
  many: string;
  suffix?: string;
}) {
  return (
    <p>
      <span className="text-2xl font-bold text-ink dark:text-neutral-100">
        {n.toLocaleString("en-US")}
      </span>{" "}
      {n === 1 ? one : many}
      {suffix && ` ${suffix}`}
    </p>
  );
}
