import { createHash } from "node:crypto";

// What the site keeps in Next's cross-request cache (unstable_cache), so
// readers that don't need the database wake it at most about once per time
// limit rather than on every visit. Each entry is keyed by:
//
// - What the deploy brings: a built-in text's hash and, where Vercel sets
//   VERCEL_DEPLOYMENT_ID, the deployment. Vercel's cache outlives a deploy,
//   so there a new deploy never serves what an older one cached. Without
//   that variable (a local server) the key ends ":local", and only the hash
//   tells deploys apart.
// - A time bucket (timeBucket()). Past its `revalidate`, unstable_cache
//   hands back the stale entry once more and refreshes it in the background,
//   so an entry could be any age when it's read. A new bucket is a new key,
//   a miss, and so a fresh read: that's what makes the time limit real.
//   `revalidate` is left off, since the bucket does its work.
//
// Saves through Next also clear an entry at once: by its tag, and, for pages,
// by revalidatePath("/", "layout"), which expires every entry a page reads.

// The words on people's pages (src/lib/page-copy.ts). A save at /admin/copy
// or through a copy key clears it at once; a load from the command line
// (`npm run admin -- copy set`), which runs outside Next, shows within the
// time limit.
export const COPY_TAG = "copy";

// One text bots read, such as the connector's instructions (src/lib/skill.ts),
// cleared when an admin saves it.
export function botTextTag(key: string): string {
  return `bot-text:${key}`;
}

const HOUR = 60 * 60;

// The connector's instructions: a save clears them, so this only bounds a
// save made outside Next.
export const BOT_TEXT_CACHE_SECONDS = HOUR;

// The words and the home page's counts. An hour, since a shorter limit than
// the database's own idle time (five minutes on Neon) would
// keep nothing it isn't awake for anyway. The evals' local server sets a
// second or two, since their stand-in admin saves from a script, which
// can't clear the cache.
export function pageCacheSeconds(): number {
  const raw = Number(process.env.UNPROMPTED_PAGE_CACHE_SECONDS);
  return Number.isInteger(raw) && raw > 0 ? raw : HOUR;
}

// The clock the buckets follow; tests move it.
export const cacheClock = { now: (): number => Date.now() };

// Which `seconds`-long window of the clock it is now.
export function timeBucket(seconds: number): number {
  return Math.floor(cacheClock.now() / (seconds * 1000));
}

const hashes = new Map<string, string>();

// What a cached entry was made from: the built-in text it was checked
// against, and the deployment, whose code decides which saved versions fit.
export function buildKey(builtIn: string): string {
  let hash = hashes.get(builtIn);
  if (hash === undefined) {
    hash = createHash("sha256").update(builtIn).digest("hex");
    if (hashes.size > 16) hashes.clear();
    hashes.set(builtIn, hash);
  }
  return `${hash}:${process.env.VERCEL_DEPLOYMENT_ID ?? "local"}`;
}
