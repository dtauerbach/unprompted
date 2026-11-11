import "server-only";
import { unstable_cache } from "next/cache";
import { type SiteStats, siteStats } from "./board";
import { pageCacheSeconds } from "./shared-cache";

// The home page's three counts, kept a few minutes in Next's cross-request
// cache, so a visit to the home page doesn't wake the database by itself.
// Nothing clears it: counts a few minutes old are fine.
export const homeStats: () => Promise<SiteStats> = unstable_cache(
  async () => siteStats(),
  ["home-stats"],
  { revalidate: pageCacheSeconds() },
);
