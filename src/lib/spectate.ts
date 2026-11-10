import "server-only";
import { type Feed, type FeedList, feedSchema, listSchema } from "./spectator";
import { type Watchable, watchable } from "./tables";

// Reading a Table's spectator feed to show people a match. The site stores
// nothing from it: each page fetches the feed afresh, checks it against the
// format, and draws it as plain text. Only addresses in tables.ts are ever
// fetched, with no redirects, a short deadline and a size cap, so a slow or
// broken Table costs one page a few seconds and nothing more.

export const FETCH_TIMEOUT_MS = 4000;
export const MAX_FEED_BYTES = 1_500_000;
const MATCH_ID = /^[A-Za-z0-9_-]{1,64}$/;

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

export type Listing = {
  table: Watchable;
  matches: FeedList["matches"] | null;
};

// Each watchable Table's recent matches; a Table that can't be read or
// sends something off-format shows as unreachable, not as an error page.
export async function recentMatches(): Promise<Listing[]> {
  return Promise.all(
    watchable().map(async (table) => {
      try {
        const parsed = listSchema.safeParse(await getJson(table.url));
        return { table, matches: parsed.success ? parsed.data.matches : null };
      } catch {
        return { table, matches: null };
      }
    }),
  );
}

export type Watched =
  | { kind: "feed"; table: Watchable; feed: Feed }
  | { kind: "unreachable"; table: Watchable }
  | { kind: "missing" };

export async function watchMatch(slug: string, id: string): Promise<Watched> {
  const table = tableBySlug(slug);
  if (!table || !MATCH_ID.test(id)) return { kind: "missing" };
  try {
    const parsed = feedSchema.safeParse(
      await getJson(`${table.url}/${encodeURIComponent(id)}`),
    );
    if (!parsed.success || parsed.data.match.id !== id)
      return { kind: "unreachable", table };
    return { kind: "feed", table, feed: parsed.data };
  } catch (e) {
    if (e instanceof NotFound) return { kind: "missing" };
    return { kind: "unreachable", table };
  }
}
