import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Refresh } from "@/components/refresh";
import { MatchView } from "@/components/spectator";
import { readCopy } from "@/lib/copy";
import { tableBySlug, watchMatch } from "@/lib/spectate";

// The tab names the Table by the name in tables.ts, never by anything the
// Table or a player sent.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ table: string }>;
}): Promise<Metadata> {
  const { table } = await params;
  const found = tableBySlug(table);
  return found ? { title: found.name } : {};
}

export default async function MatchPage({
  params,
}: {
  params: Promise<{ table: string; match: string }>;
}) {
  await connection();
  const { table, match } = await params;
  const [watched, t] = await Promise.all([
    watchMatch(table, match),
    readCopy(),
  ]);
  if (watched.kind === "missing") notFound();
  const back = (
    <Link href="/play" className="text-sm underline">
      {t["play.back"]}
    </Link>
  );
  if (watched.kind === "unreachable")
    return (
      <div className="space-y-4">
        {back}
        <h1 className="text-2xl font-bold tracking-tight">
          {watched.table.name}
        </h1>
        <p>{t["play.unreachable"]}</p>
      </div>
    );
  return (
    <div className="space-y-4">
      {back}
      <MatchView feed={watched.feed} table={watched.table.name} t={t} />
      {watched.feed.match.status === "live" ? <Refresh /> : null}
    </div>
  );
}
