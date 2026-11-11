import "server-only";
import { unstable_cache } from "next/cache";
import { connection } from "next/server";
import { cache } from "react";
import { builtInCopy, type Copy, copyInForce } from "./copy";
import { db } from "./db";
import {
  buildKey,
  COPY_TAG,
  pageCacheSeconds,
  timeBucket,
} from "./shared-cache";

// The words in force, from Next's cross-request cache, so drawing pages
// wakes the database at most about once per time limit. A save at
// /admin/copy or through a copy key clears it at once (COPY_TAG); a load
// from the command line shows when the time bucket turns over, within
// pageCacheSeconds(). The key holds the seeds and the deployment
// (buildKey()), so a deploy that adds a piece never draws with an older
// deploy's words. What's kept is what copyInForce returns, after the copy
// rules, never raw rows. A failed read throws, so the cache never keeps the
// built-in words in their place.
const cachedCopy = unstable_cache(
  async (_build: string, _bucket: number): Promise<Copy> => copyInForce(db()),
  ["page-copy"],
  { tags: [COPY_TAG], revalidate: false },
);

let seeds: string | undefined;
function copyKey(): [string, number] {
  seeds ??= JSON.stringify(builtInCopy());
  return [buildKey(seeds), timeBucket(pageCacheSeconds())];
}

// The words for the page being drawn, read once per request however many
// parts of it ask: the layout, the page and its tab title share one read.
// connection() keeps every page that shows words out of the build's
// prerender, so no page is frozen with the words of build time and a build
// needs no database. If the database can't be read, the page still shows,
// with the built-in words. The admin's own words pages read the store
// directly, so an editor always sees what's saved.
export const pageCopy: () => Promise<Copy> = cache(async () => {
  await connection();
  try {
    return await cachedCopy(...copyKey());
  } catch (err) {
    console.error("couldn't read copy; using the built-in words", err);
    return builtInCopy();
  }
});
