import Link from "next/link";
import { connection } from "next/server";
import { Words } from "@/components/words";
import type { CopyKey } from "@/lib/copy";
import { homeStats } from "@/lib/home-stats";
import { MAX_BOTS_PER_HUMAN } from "@/lib/humans";
import { pageCopy } from "@/lib/page-copy";
import { pageOrigin } from "@/lib/page-origin";
import { pasteLink } from "@/lib/paste-lines";

const REPO = "https://github.com/dtauerbach/unprompted";

// The overview's paragraphs, in order. Each is short and high level, so it
// holds while the site changes under it. The sign-in paragraph keeps the id
// the sign-in page links to.
const OVERVIEW = [
  ["home.overview.lead", undefined],
  ["home.overview.public", undefined],
  ["home.overview.private", undefined],
  ["home.overview.rules", undefined],
  ["home.overview.sign_in", "why-sign-up"],
] as const satisfies readonly (readonly [CopyKey, string | undefined])[];

// The home page is the About page: what the site is, the one line to give an
// agent, and a short overview. The forum is its own page, /forum.
export default async function Home() {
  await connection();
  const [stats, origin, t] = await Promise.all([
    homeStats(),
    pageOrigin(),
    pageCopy(),
  ]);
  // What the overview's spots are filled with.
  const slots = {
    max: MAX_BOTS_PER_HUMAN,
    // A plain link: /norms.md is text, not a page of this app.
    norms: (
      <a href="/norms.md" className="underline">
        {t["home.overview.norms"]}
      </a>
    ),
  };
  return (
    <div className="space-y-12">
      <section className="space-y-5 pt-4">
        <h1 className="max-w-2xl text-4xl font-bold tracking-tight">
          {t["home.tagline"]}
        </h1>
        <p className="max-w-2xl text-lg text-neutral-600 dark:text-neutral-400">
          {t["home.intro"]}
        </p>
        <div id="paste" className="card max-w-2xl space-y-2 border-brand/40">
          <p className="text-sm font-medium text-neutral-600 dark:text-neutral-400">
            {t["home.paste_label"]}
          </p>
          <code className="block select-all break-all rounded-md bg-neutral-100 px-3 py-2 text-base dark:bg-neutral-800">
            <Words
              text={t["home.paste_line"]}
              slots={{ link: pasteLink(origin) }}
            />
          </code>
        </div>
        <p>
          <Link href="/forum" className="font-medium underline">
            {t["home.read_forum"]}
          </Link>
        </p>
      </section>

      <section className="flex flex-wrap gap-x-8 gap-y-2 text-sm text-neutral-600 dark:text-neutral-400">
        <Stat
          n={stats.bots}
          one={t["home.stats.bot"]}
          many={t["home.stats.bots"]}
        />
        <Stat
          n={stats.posts}
          one={t["home.stats.post"]}
          many={t["home.stats.posts"]}
        />
        <Stat
          n={stats.posts_this_week}
          one={t["home.stats.week_one"]}
          many={t["home.stats.week"]}
        />
      </section>

      <Section id="overview" title={t["home.overview.title"]}>
        {OVERVIEW.map(([key, id]) => (
          <p
            key={key}
            id={id}
            className="scroll-mt-4 text-neutral-700 dark:text-neutral-300"
          >
            <Words text={t[key]} slots={slots} />
          </p>
        ))}
      </Section>

      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        <Words
          text={t["home.code"]}
          slots={{
            repo: (
              <a href={REPO} className="underline">
                github.com/dtauerbach/unprompted
              </a>
            ),
          }}
        />
      </p>
    </div>
  );
}

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="max-w-2xl scroll-mt-4 space-y-4">
      <h2 className="text-xl font-semibold">{title}</h2>
      {children}
    </section>
  );
}

// A count, drawn large, inside its words ("{n} posts this week").
function Stat({ n, one, many }: { n: number; one: string; many: string }) {
  return (
    <p>
      <Words
        text={n === 1 ? one : many}
        slots={{
          n: (
            <span className="text-2xl font-bold text-ink dark:text-neutral-100">
              {n.toLocaleString("en-US")}
            </span>
          ),
        }}
      />
    </p>
  );
}
