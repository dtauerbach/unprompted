import { cacheClock } from "@/lib/shared-cache";

// A stand-in for next/cache in tests, which run outside Next, where the real
// unstable_cache has nothing to keep entries in. It follows Next 16's
// semantics for what the site uses (node_modules/next/dist/server/web/
// spec-extension/unstable-cache.js and lib/incremental-cache/):
//
// - Entries are keyed by key parts and arguments, and kept as JSON.
// - Past `revalidate` seconds an entry is stale: it's handed back once more
//   while a refresh runs in the background (settleNextCache() waits for it).
//   `revalidate: false` never goes stale by time.
// - updateTag(tag) and revalidateTag(tag, { expire: 0 }) expire the tag's
//   entries: the next read is a miss. revalidateTag(tag, "max") only makes
//   them stale.
// - revalidatePath("/", "layout") expires every entry a page reads, since
//   each page's reads carry the root layout's implicit tag; every read here
//   is taken as a page's. Other paths are only recorded.
// - It doesn't know a server action from a route handler, so it can't throw
//   where Next's updateTag would; src/test/page-cache.test.ts checks that
//   only server action files call it.
//
// setup.ts puts it in place for every test file, emptied before each test.
// It also pins the clock the cache follows (cacheClock), half way through an
// hour, so a test can't see a bucket turn over while it runs; a test that
// wants a new bucket moves it with setCacheClock().

// Writes and tag changes are ordered by a counter rather than the clock, so
// two in the same millisecond still come in order.
type Entry = {
  json: string;
  tags: string[];
  seq: number;
  staleAt: number;
};

const ROOT_LAYOUT = "_N_T_/layout";
const YEAR_MS = 365 * 24 * 3600 * 1000;

const entries = new Map<string, Entry>();
const tagState = new Map<string, { seq: number; expiredAt: number }>();
let seq = 0;
const pending = new Set<Promise<unknown>>();

export const cacheCalls = {
  updateTag: [] as string[],
  revalidateTag: [] as { tag: string; profile: unknown }[],
  revalidatePath: [] as { path: string; type?: string }[],
};

// Half past midnight UTC on a fixed day: mid-way through an hour's bucket.
export const PINNED_CLOCK = Date.UTC(2026, 0, 1, 0, 30);
let clock = PINNED_CLOCK;

export function setCacheClock(ms: number): void {
  clock = ms;
}

export function resetNextCache(): void {
  clock = PINNED_CLOCK;
  cacheClock.now = () => clock;
  entries.clear();
  tagState.clear();
  pending.clear();
  seq = 0;
  cacheCalls.updateTag.length = 0;
  cacheCalls.revalidateTag.length = 0;
  cacheCalls.revalidatePath.length = 0;
}

export function cachedKeys(): string[] {
  return [...entries.keys()];
}

// Waits for the background refreshes that stale reads started.
export async function settleNextCache(): Promise<void> {
  await Promise.allSettled([...pending]);
}

function tagsOf(e: Entry): string[] {
  return [...e.tags, ROOT_LAYOUT];
}

function expired(e: Entry, now: number): boolean {
  return tagsOf(e).some((t) => {
    const s = tagState.get(t);
    return s !== undefined && s.expiredAt <= now && s.seq > e.seq;
  });
}

function stale(e: Entry, now: number): boolean {
  if (e.staleAt <= now) return true;
  return tagsOf(e).some((t) => (tagState.get(t)?.seq ?? 0) > e.seq);
}

export function unstable_cache<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  keyParts: string[] = [],
  opts: { tags?: string[]; revalidate?: number | false } = {},
): (...args: A) => Promise<R> {
  const store = (key: string, value: R) => {
    const now = cacheClock.now();
    entries.set(key, {
      json: JSON.stringify(value),
      tags: opts.tags ?? [],
      seq: ++seq,
      staleAt: opts.revalidate ? now + opts.revalidate * 1000 : Infinity,
    });
  };
  return async (...args: A) => {
    const key = JSON.stringify([keyParts, args]);
    const now = cacheClock.now();
    const hit = entries.get(key);
    if (hit && !expired(hit, now)) {
      if (stale(hit, now)) {
        // A failed refresh keeps the stale entry, as in Next.
        const refresh = fn(...args)
          .then((v) => store(key, v))
          .catch(() => {});
        pending.add(refresh);
        refresh.finally(() => pending.delete(refresh));
      }
      return JSON.parse(hit.json);
    }
    // A throw keeps nothing, as in Next.
    const value = await fn(...args);
    store(key, value);
    return JSON.parse(JSON.stringify(value));
  };
}

function expire(tag: string, expireSeconds: number): void {
  tagState.set(tag, {
    seq: ++seq,
    expiredAt: cacheClock.now() + expireSeconds * 1000,
  });
}

export function updateTag(tag: string): void {
  cacheCalls.updateTag.push(tag);
  expire(tag, 0);
}

export function revalidateTag(
  tag: string,
  profile: string | { expire?: number },
): void {
  cacheCalls.revalidateTag.push({ tag, profile });
  const seconds =
    typeof profile === "object" && profile.expire !== undefined
      ? profile.expire
      : YEAR_MS / 1000;
  expire(tag, seconds);
}

export function revalidatePath(path: string, type?: string): void {
  cacheCalls.revalidatePath.push({ path, type });
  if (path === "/" && type === "layout") expire(ROOT_LAYOUT, 0);
}
