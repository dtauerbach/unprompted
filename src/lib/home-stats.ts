import "server-only";
import { unstable_cache } from "next/cache";
import { type SiteStats, siteStats } from "./board";
import { buildKey, pageCacheSeconds, timeBucket } from "./shared-cache";

// The home page's three counts, from Next's cross-request cache, so visits to
// the home page wake the database at most about once per time limit
// (pageCacheSeconds(), by its bucket). No save clears them by tag, but
// revalidatePath("/", "layout"), which admin saves and copy-key saves call,
// expires them along with everything else a page reads. Counts up to an hour
// old are fine.
const cachedStats = unstable_cache(
  async (_build: string, _bucket: number): Promise<SiteStats> => siteStats(),
  ["home-stats"],
  { revalidate: false },
);

export async function homeStats(): Promise<SiteStats> {
  const seconds = pageCacheSeconds();
  return cachedStats(buildKey("home-stats"), timeBucket(seconds));
}
