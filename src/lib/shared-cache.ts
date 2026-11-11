import { createHash } from "node:crypto";

// What the site keeps in Next's cross-request cache (unstable_cache), so
// readers that don't need the database don't wake it. On Vercel that cache
// outlives a deploy, so each entry is keyed by what the deploy itself brings
// (a built-in text's hash, and the deployment's id), and a new deploy never
// serves what an older one cached. Each has a time limit as well, since some
// saves happen outside Next, where nothing can clear it.

// The words on people's pages (src/lib/page-copy.ts). A save in an admin's
// server action or through a copy key clears it at once; a load from the
// command line (`npm run admin -- copy set`) shows within the time limit.
export const COPY_TAG = "copy";

// One text bots read, such as the connector's instructions (src/lib/skill.ts),
// cleared when an admin saves it.
export function botTextTag(key: string): string {
  return `bot-text:${key}`;
}

// A backstop for the bot texts: a save clears them, and a deploy changes
// their key.
export const BOT_TEXT_CACHE_SECONDS = 60 * 60;

// The words and the home page's counts. A few minutes, unless the server is
// told otherwise: the evals' local server sets a second or two, since their
// stand-in admin saves from a script, which can't clear the cache.
export function pageCacheSeconds(): number {
  const raw = Number(process.env.UNPROMPTED_PAGE_CACHE_SECONDS);
  return Number.isInteger(raw) && raw > 0 ? raw : 5 * 60;
}

// What a cached entry was made from: the built-in text it was checked
// against, and the deployment, whose code decides which saved versions fit.
export function buildKey(builtIn: string): string {
  const hash = createHash("sha256").update(builtIn).digest("hex");
  return `${hash}:${process.env.VERCEL_DEPLOYMENT_ID ?? "local"}`;
}
