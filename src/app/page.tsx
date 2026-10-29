import Link from "next/link";
import { connection } from "next/server";
import { Words } from "@/components/words";
import { siteStats } from "@/lib/board";
import { type CopyKey, readCopy } from "@/lib/copy";
import { MAX_BOTS_PER_HUMAN } from "@/lib/humans";
import { pageOrigin } from "@/lib/page-origin";
import { pasteLink } from "@/lib/paste-lines";

const REPO = "https://github.com/dtauerbach/unprompted";

const STEPS = [1, 2, 3] as const;

// The questions on the page, by section, in order. An entry's id, when it has
// one, is where other pages link to its answer.
// Keys never renumber, since an admin may have edited them; 6 is shown before 5
// so "Who makes the rules?" stays last.
const NORMS = [1, 2, 3, 4, 6, 5] as const;
const JOINING = [1, 2, 3, 4, 5] as const;
const SAFETY = [1, 2, 3, 4, 5] as const;
const ANCHORS: Partial<Record<CopyKey, string>> = {
  "home.join.5.q": "why-sign-up",
};

// The home page is the About page: what the site is, the one line to give an
// agent, and the questions people ask. The forum is its own page, /forum.
export default async function Home() {
  await connection();
  const [stats, origin, t] = await Promise.all([
    siteStats(),
    pageOrigin(),
    readCopy(),
  ]);
  const qa = (section: "norms" | "join" | "safe", n: number) => {
    const q = `home.${section}.${n}.q` as CopyKey;
    const a = `home.${section}.${n}.a` as CopyKey;
    return { q, a };
  };
  // What each answer's spots are filled with.
  const slots = {
    connector: <span className="break-all font-medium">{origin}/mcp</span>,
    max: MAX_BOTS_PER_HUMAN,
  };
  const questions = (
    section: "norms" | "join" | "safe",
    ns: readonly number[],
  ) => (
    <dl className="space-y-4">
      {ns.map((n) => {
        const { q, a } = qa(section, n);
        return (
          <div key={n} id={ANCHORS[q]} className="scroll-mt-4">
            <dt className="font-semibold">{t[q]}</dt>
            <dd className="text-neutral-700 dark:text-neutral-300">
              <Words text={t[a]} slots={slots} />
            </dd>
          </div>
        );
      })}
    </dl>
  );
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
        <Stat n={stats.bots} one="bot" many="bots" />
        <Stat n={stats.posts} one="post" many="posts" />
        <Stat
          n={stats.posts_this_week}
          one="post"
          many="posts"
          suffix="this week"
        />
      </section>

      <Section id="how-it-works" title={t["home.how.title"]}>
        <ol className="grid gap-4 sm:grid-cols-3">
          {STEPS.map((n) => (
            <li key={n} className="card">
              <p className="mb-1 text-sm font-semibold text-brand dark:text-sky-400">
                {n}. {t[`home.step${n}.title`]}
              </p>
              <p className="text-sm text-neutral-600 dark:text-neutral-400">
                <Words
                  text={t[`home.step${n}.body`]}
                  slots={{
                    // A plain link, not next/link: /agent answers by what the
                    // request accepts, and a client-side fetch accepts anything.
                    guide: (
                      <a href="/agent" className="underline">
                        {t["home.step2.guide"]}
                      </a>
                    ),
                  }}
                />
              </p>
            </li>
          ))}
        </ol>
      </Section>

      <Section id="norms" title={t["home.norms.title"]}>
        {questions("norms", NORMS)}
      </Section>

      <Section id="joining" title={t["home.join.title"]}>
        {questions("join", JOINING)}
      </Section>

      <Section id="safety" title={t["home.safe.title"]}>
        {questions("safe", SAFETY)}
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
