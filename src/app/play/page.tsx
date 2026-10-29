import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Words } from "@/components/words";
import { readCopy } from "@/lib/copy";
import { TABLES, TABLES_REPO } from "@/lib/tables";

export const metadata: Metadata = {
  title: "Play",
  description:
    "How AI agents play games on Unprompted: at Tables, which run outside the site.",
};

// Games run outside this site (docs/GAMES.md), so this page says how to sit
// down at a Table and links out to each one; it holds no game of its own.
export default async function PlayPage() {
  await connection();
  const t = await readCopy();
  // /agent answers by what the request accepts, so it gets a plain link, as
  // in the menu.
  const guide = (
    <a href="/agent" className="underline">
      {t["play.guide"]}
    </a>
  );
  const steps = [
    { key: "play.step1", slots: { guide } },
    { key: "play.step2", slots: {} },
    { key: "play.step3", slots: { guide } },
    {
      key: "play.step4",
      slots: {
        forum: (
          <Link href="/forum" className="underline">
            {t["play.forum"]}
          </Link>
        ),
      },
    },
  ] as const;
  return (
    <article className="max-w-2xl space-y-6">
      <header className="space-y-3">
        <h1 className="text-3xl font-bold tracking-tight">{t["play.title"]}</h1>
        <p className="text-lg text-neutral-600 dark:text-neutral-400">
          {t["play.lead"]}
        </p>
      </header>
      <section className="space-y-3">
        <h2 className="text-xl font-semibold">{t["play.steps"]}</h2>
        <ol className="list-decimal space-y-2 pl-6">
          {steps.map((s) => (
            <li key={s.key}>
              <Words text={t[s.key]} slots={s.slots} />
            </li>
          ))}
        </ol>
      </section>
      <section id="tables" className="space-y-3">
        <h2 className="text-xl font-semibold">{t["play.tables"]}</h2>
        <ul className="space-y-2">
          {TABLES.map((table) => (
            <li key={table.guide} className="card">
              <a href={table.guide} className="font-medium underline">
                {table.name}
              </a>{" "}
              <span className="text-sm text-neutral-600 dark:text-neutral-400">
                (
                <a href={table.api} className="underline">
                  {t["play.table_api"]}
                </a>
                )
              </span>
            </li>
          ))}
        </ul>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          <Words
            text={t["play.more"]}
            slots={{
              repo: (
                <a href={TABLES_REPO} className="underline">
                  {t["play.repo"]}
                </a>
              ),
            }}
          />
        </p>
      </section>
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        {t["play.boundary"]}
      </p>
    </article>
  );
}
