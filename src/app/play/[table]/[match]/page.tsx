import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { cache } from "react";
import { Refresh } from "@/components/refresh";
import { MatchView } from "@/components/spectator";
import { fill } from "@/lib/copy";
import { pageCopy } from "@/lib/page-copy";
import { watchMatch } from "@/lib/spectate";
import { utcDay } from "@/lib/time";

// One read of the match for the tab and the page alike.
const watched = cache(watchMatch);

// The match's one address here, for search engines.
const canonical = (slug: string, id: string) =>
  `/play/${slug}/${encodeURIComponent(id)}`;

// The tab and the search result name the Table by the name in tables.ts and
// the day the match started, as the site formats it from the checked feed;
// nothing the Table or a player wrote reaches them. A match that's hidden or
// missing says nothing; one that can't be read isn't indexed.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ table: string; match: string }>;
}): Promise<Metadata> {
  await connection();
  const { table, match } = await params;
  const [w, t] = await Promise.all([watched(table, match), pageCopy()]);
  if (w.kind === "missing") return {};
  if (w.kind === "unreachable")
    return { title: w.table.name, robots: { index: false } };
  const date = utcDay(new Date(w.feed.match.started_at));
  const name = w.table.name;
  const count = w.feed.participants.filter((p) => p.kind === "bot").length;
  return {
    title: fill(t["play.match_tab"], { table: name, date }),
    description: fill(t["play.match_description"], {
      table: name,
      date,
      count,
    }),
    alternates: {
      canonical: canonical(w.table.slug, w.feed.match.id),
    },
    ...(w.feed.match.status === "live" ? { robots: { index: false } } : {}),
  };
}

export default async function MatchPage({
  params,
}: {
  params: Promise<{ table: string; match: string }>;
}) {
  await connection();
  const { table, match } = await params;
  const [w, t] = await Promise.all([watched(table, match), pageCopy()]);
  if (w.kind === "missing") notFound();
  const back = (
    <Link href="/play" className="text-sm underline">
      {t["play.back"]}
    </Link>
  );
  if (w.kind === "unreachable")
    return (
      <div className="space-y-4">
        {back}
        <h1 className="text-2xl font-bold tracking-tight">{w.table.name}</h1>
        <p>{t["play.unreachable"]}</p>
        {/* One failed read shouldn't stop a live game's page updating. */}
        <Refresh />
      </div>
    );
  return (
    <div className="space-y-4">
      {back}
      <MatchView
        feed={w.feed}
        table={w.table.name}
        t={t}
        held={w.held}
        bots={w.bots}
      />
      {w.feed.match.status === "live" ? <Refresh /> : null}
    </div>
  );
}
