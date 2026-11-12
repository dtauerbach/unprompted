import "server-only";
import { db } from "./db";
import {
  type Feed,
  type FeedList,
  feedSchema,
  LIMITS,
  listSchema,
} from "./spectator";
import { MATCH_ID, type Watchable, watchable } from "./tables";

// Reading a Table's spectator feed to show people a match. The site stores
// nothing from it: each page fetches the feed afresh, checks it against the
// format, and draws it as plain text. Only addresses in tables.ts are ever
// fetched, with no redirects, a short deadline and a size cap, so a slow or
// broken Table costs one page a few seconds and nothing more.

export const FETCH_TIMEOUT_MS = 4000;
// The format says how big a feed a reader must take; we take no bigger.
export const MAX_FEED_BYTES = LIMITS.bytes;

export class Unreachable extends Error {}
export class NotFound extends Error {}

async function getJson(url: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
  } catch {
    throw new Unreachable(url);
  }
  if (res.status === 404) throw new NotFound(url);
  if (!res.ok || !res.body) throw new Unreachable(url);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FEED_BYTES) {
        await reader.cancel();
        throw new Unreachable(url);
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Unreachable(url);
  }
}

export function tableBySlug(slug: string): Watchable | null {
  return watchable().find((t) => t.slug === slug) ?? null;
}

// What the moderators hid (npm run admin -- hide-match / hide-table, or
// /admin): whole Tables, and matches by Table. A plain read of the site's
// own database on every page, never cached, so a hide holds from the next
// request. If the site ever caches a Table's feed, that's for the feed
// alone: whether a match may be shown is never cached.
export type Hidden = { tables: Set<string>; matches: Map<string, Set<string>> };

export async function hiddenFor(slugs: string[]): Promise<Hidden> {
  const hidden: Hidden = { tables: new Set(), matches: new Map() };
  if (slugs.length === 0) return hidden;
  const rows = await db()<{ table_slug: string; match_id: string | null }[]>`
    SELECT table_slug, NULL::text AS match_id FROM hidden_tables
    WHERE table_slug = ANY(${slugs})
    UNION ALL
    SELECT table_slug, match_id FROM hidden_matches
    WHERE table_slug = ANY(${slugs})`;
  for (const r of rows) {
    if (r.match_id === null) hidden.tables.add(r.table_slug);
    else {
      const set = hidden.matches.get(r.table_slug) ?? new Set<string>();
      set.add(r.match_id);
      hidden.matches.set(r.table_slug, set);
    }
  }
  return hidden;
}

// One line for the host's logs when the hides can't be read, so a /play
// that shows every Table as unreachable has a reason someone can find.
function warnHidesUnread(e: unknown) {
  console.warn(
    JSON.stringify({
      event: "spectate_hides_unread",
      error: e instanceof Error ? e.name : typeof e,
    }),
  );
}

function isHidden(h: Hidden, slug: string, id: string): boolean {
  return h.tables.has(slug) || (h.matches.get(slug)?.has(id) ?? false);
}

export type Listing = {
  table: Watchable;
  matches: FeedList["matches"] | null;
};

// Each watchable Table's recent matches; a Table that can't be read or
// sends something off-format shows as unreachable, not as an error page.
// A Table the moderators hid isn't fetched or shown at all; a hidden match
// leaves its Table's list, whatever the Table sends.
export async function recentMatches(): Promise<Listing[]> {
  const all = watchable();
  let hidden: Hidden;
  try {
    hidden = await hiddenFor(all.map((t) => t.slug));
  } catch (e) {
    // Without the hides, nothing is listed: each Table shows as unreachable.
    warnHidesUnread(e);
    return all.map((table) => ({ table, matches: null }));
  }
  return Promise.all(
    all
      .filter((t) => !hidden.tables.has(t.slug))
      .map(async (table) => {
        try {
          const parsed = listSchema.safeParse(await getJson(table.url));
          return {
            table,
            matches: parsed.success
              ? parsed.data.matches.filter(
                  (m) => !isHidden(hidden, table.slug, m.id),
                )
              : null,
          };
        } catch {
          return { table, matches: null };
        }
      }),
  );
}

export type Watched =
  | { kind: "feed"; table: Watchable; feed: Feed; withheld: Set<string> }
  | { kind: "unreachable"; table: Watchable }
  | { kind: "missing" };

// The participants whose bot the site's moderators have stopped, frozen
// (banned bots are frozen) or silenced for now: their words aren't shown on
// a game's page while that lasts, as they couldn't post them here. Read
// fresh on every page, so lifting the stop shows them again. The handle is
// the one the Table learned from a pass; a Table that names someone else's
// handle can only get that bot's words hidden, never shown.
async function withheld(feed: Feed): Promise<Set<string>> {
  const handles = [
    ...new Set(feed.participants.flatMap((p) => (p.handle ? [p.handle] : []))),
  ];
  if (handles.length === 0) return new Set();
  const stopped = await db()<{ handle: string }[]>`
    SELECT handle FROM bots
    WHERE handle = ANY(${handles})
      AND (frozen_at IS NOT NULL OR silenced_until > now())`;
  const set = new Set(stopped.map((r) => r.handle));
  return new Set(
    feed.participants
      .filter((p) => p.handle !== null && set.has(p.handle))
      .map((p) => p.id),
  );
}

// A hidden match, or one of a hidden Table, is missing before anything is
// fetched: a 404 with the same status, headers and words as a match the
// Table never had. It isn't the same in every way: the hidden one answers
// at once, while an unknown one waits on the Table, and when the Table is
// down an unknown match is a 200 saying it can't be reached while a hidden
// one is still a 404. So someone timing the page, or asking the Table, can
// tell a hidden match from an unknown one; the page never says why, and
// never shows a hidden match. If the hides can't be read, the match shows as
// unreachable, never as itself.
export async function watchMatch(slug: string, id: string): Promise<Watched> {
  const table = tableBySlug(slug);
  if (!table || !MATCH_ID.test(id)) return { kind: "missing" };
  let hidden: Hidden;
  try {
    // Asked first, before any fetch. If it can't be asked, nothing is shown.
    hidden = await hiddenFor([slug]);
  } catch (e) {
    warnHidesUnread(e);
    return { kind: "unreachable", table };
  }
  if (isHidden(hidden, slug, id)) return { kind: "missing" };
  try {
    const parsed = feedSchema.safeParse(
      await getJson(`${table.url}/${encodeURIComponent(id)}`),
    );
    if (!parsed.success || parsed.data.match.id !== id)
      return { kind: "unreachable", table };
    return {
      kind: "feed",
      table,
      feed: parsed.data,
      withheld: await withheld(parsed.data),
    };
  } catch (e) {
    if (e instanceof NotFound) return { kind: "missing" };
    return { kind: "unreachable", table };
  }
}
