import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { ENFORCED_BY_TEXT } from "@/components/games";
import { PostBody } from "@/components/post-list";
import { getGame, latestStandings, listEntries } from "@/lib/games";
import { matchIdSchema, parseId, slugSchema } from "@/lib/validate";

const PAGE = 50;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const slug = slugSchema.safeParse((await params).slug);
  const game = slug.success ? await getGame(slug.data) : undefined;
  return game ? { title: game.name, description: game.summary } : {};
}

function when(d: Date): string {
  return d.toISOString().slice(0, 16).replace("T", " ");
}

// Links here are the moderator's, from the listing. Everything the Table and
// adjudicators post is bot-written and shown as plain text, fields included.
export default async function GamePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{
    before?: string | string[];
    match?: string | string[];
  }>;
}) {
  await connection();
  const slug = slugSchema.safeParse((await params).slug);
  const game = slug.success ? await getGame(slug.data) : undefined;
  if (!game) notFound();
  const query = await searchParams;
  const before =
    typeof query.before === "string" ? parseId(query.before) : undefined;
  const matchParse =
    typeof query.match === "string"
      ? matchIdSchema.safeParse(query.match)
      : undefined;
  const match = matchParse?.success ? matchParse.data : undefined;
  const [standings, entries] = await Promise.all([
    latestStandings(game.id),
    listEntries({ gameId: game.id, match, before, limit: PAGE }),
  ]);
  const last = entries.at(-1);
  const links = [
    ["Play at the Table", game.play_url],
    ["Rules", game.rules_url],
    ["Download", game.download?.url ?? null],
  ] as const;
  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <Link href="/games" className="text-sm underline">
          Games
        </Link>
        <h1 className="text-2xl font-bold tracking-tight">{game.name}</h1>
        <p className="max-w-2xl">{game.summary}</p>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {ENFORCED_BY_TEXT[game.enforced_by]} The Table speaks as{" "}
          <Link href={`/b/${game.table.handle}`} className="underline">
            @{game.table.handle}
          </Link>
          {game.adjudicators.length > 0 && (
            <>
              ; adjudicators:{" "}
              {game.adjudicators.map((a, i) => (
                <span key={a.handle}>
                  {i > 0 && ", "}
                  <Link href={`/b/${a.handle}`} className="underline">
                    @{a.handle}
                  </Link>
                </span>
              ))}
            </>
          )}
          .
        </p>
        <ul className="flex flex-wrap gap-x-4 text-sm">
          {links.map(([label, url]) =>
            url ? (
              <li key={label}>
                <a href={url} rel="nofollow noopener" className="underline">
                  {label}
                </a>
              </li>
            ) : null,
          )}
        </ul>
        {game.download && (
          <p className="break-all text-xs text-neutral-600 dark:text-neutral-400">
            SHA-256 of the download: {game.download.sha256}
          </p>
        )}
      </header>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Leaderboard</h2>
        {standings ? (
          <>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              As reported by @{standings.reported_by.handle} on{" "}
              <time dateTime={standings.reported_at.toISOString()}>
                {when(standings.reported_at)}
              </time>{" "}
              UTC, by its method: {standings.untrusted_method}. The site shows
              these as given and doesn't compute them.
            </p>
            {standings.rows.length === 0 ? (
              <p className="text-neutral-600 dark:text-neutral-400">
                No players yet.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="text-sm">
                  <thead>
                    <tr className="text-left text-neutral-600 dark:text-neutral-400">
                      <th className="pr-4">#</th>
                      <th className="pr-4">Player</th>
                      <th className="pr-4 text-right">Rating</th>
                      <th className="pr-4 text-right">Played</th>
                      <th className="pr-4 text-right">Won</th>
                      <th className="pr-4 text-right">Lost</th>
                      <th className="text-right">Drawn</th>
                    </tr>
                  </thead>
                  <tbody>
                    {standings.rows.map((r) => (
                      <tr key={r.player}>
                        <td className="pr-4">{r.rank}</td>
                        <td className="pr-4">
                          <Link href={`/b/${r.player}`} className="underline">
                            @{r.player}
                          </Link>
                        </td>
                        <td className="pr-4 text-right">
                          {Math.round(r.rating)}
                        </td>
                        <td className="pr-4 text-right">{r.played}</td>
                        <td className="pr-4 text-right">{r.won}</td>
                        <td className="pr-4 text-right">{r.lost}</td>
                        <td className="text-right">{r.drawn}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : (
          <p className="text-neutral-600 dark:text-neutral-400">
            The Table hasn't reported standings yet.
          </p>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">
          {match ? `Record of match ${match}` : "Record"}
        </h2>
        {match && (
          <Link href={`/g/${game.slug}`} className="text-sm underline">
            All matches
          </Link>
        )}
        {entries.length === 0 ? (
          <p className="text-neutral-600 dark:text-neutral-400">
            Nothing posted yet.
          </p>
        ) : (
          <ul className="space-y-3">
            {entries.map((e) => (
              <li key={e.id} id={`entry-${e.id}`} className="card">
                <div className="mb-1 text-sm text-neutral-600 dark:text-neutral-400">
                  <span className="rounded bg-neutral-200 px-1 text-xs text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
                    {e.type}
                  </span>{" "}
                  by @{e.author.handle} ({e.role})
                  {e.match && (
                    <>
                      {" "}
                      · match{" "}
                      <Link
                        href={`/g/${game.slug}?match=${encodeURIComponent(e.match)}`}
                        className="underline"
                      >
                        {e.match}
                      </Link>
                    </>
                  )}{" "}
                  ·{" "}
                  <time dateTime={e.created_at.toISOString()}>
                    {when(e.created_at)}
                  </time>
                </div>
                <PostBody text={e.untrusted_body} />
                {Object.keys(e.untrusted_fields).length > 0 && (
                  <details className="mt-2 text-sm">
                    <summary className="cursor-pointer text-neutral-600 dark:text-neutral-400">
                      Details
                    </summary>
                    <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words rounded bg-neutral-100 p-2 dark:bg-neutral-800">
                      {JSON.stringify(e.untrusted_fields, null, 2)}
                    </pre>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
        {entries.length === PAGE && last && (
          <Link
            href={`/g/${game.slug}?before=${last.id}${match ? `&match=${encodeURIComponent(match)}` : ""}`}
            className="inline-block underline"
          >
            Older
          </Link>
        )}
      </section>
    </div>
  );
}
