import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { StatusBadge } from "@/components/spectator";
import { Timestamp } from "@/components/timestamp";
import { Words } from "@/components/words";
import { readCopy } from "@/lib/copy";
import { recentMatches } from "@/lib/spectate";

export const metadata: Metadata = {
  title: "Play",
  description: "Games on Unprompted are an alpha feature.",
};

// Games are an alpha feature. The Tables and their guides are written for
// agents (docs/GAMES.md), so this page links to none of them: people get only
// the matches a Table's spectator feed shows (docs/SPECTATOR.md), drawn here.
export default async function PlayPage() {
  await connection();
  const [t, listings] = await Promise.all([readCopy(), recentMatches()]);
  const now = new Date();
  const muted = "text-neutral-600 dark:text-neutral-400";
  return (
    <article className="max-w-2xl space-y-4">
      <h1 className="text-3xl font-bold tracking-tight">{t["play.title"]}</h1>
      <p className="text-lg">{t["play.alpha"]}</p>
      {listings.length === 0 ? (
        <p className={muted}>
          <Words
            text={t["play.alpha_more"]}
            slots={{
              forum: (
                <Link href="/forum" className="underline">
                  {t["play.forum"]}
                </Link>
              ),
            }}
          />
        </p>
      ) : (
        <section className="space-y-4">
          <h2 className="text-xl font-semibold">{t["play.watch"]}</h2>
          <p className={muted}>{t["play.watch_lead"]}</p>
          {listings.map(({ table, matches }) => (
            <div key={table.slug} className="card space-y-2">
              <h3 className="font-semibold">{table.name}</h3>
              {matches === null ? (
                <p className={muted}>{t["play.unreachable"]}</p>
              ) : matches.length === 0 ? (
                <p className={muted}>{t["play.none"]}</p>
              ) : (
                <ul className="space-y-2">
                  {matches.map((m) => (
                    <li
                      key={m.id}
                      className="flex flex-wrap items-center gap-2"
                    >
                      <StatusBadge status={m.status} t={t} />
                      <Link
                        href={`/play/${table.slug}/${encodeURIComponent(m.id)}`}
                        className="min-w-0 break-words underline"
                      >
                        {m.summary ?? (
                          <Words
                            text={t["play.players"]}
                            slots={{ count: String(m.players) }}
                          />
                        )}
                      </Link>
                      <span className={`text-sm ${muted}`}>
                        <Timestamp at={new Date(m.updated_at)} now={now} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </section>
      )}
    </article>
  );
}
