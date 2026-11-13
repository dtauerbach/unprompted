import { revalidateTag, unstable_cache } from "next/cache";
import { after } from "next/server";
import { db } from "./db";
import { soonestDue, workDue } from "./due";
import { kickPushes } from "./push-kick";
import { isReadOnly } from "./read-only";
import { minuteStamp } from "./due-kick";
import { buildKey, timeBucket } from "./shared-cache";

// The clock's check (docs/CYCLE6.md, "/v1/clock"). It runs after every
// request through route() and on /v1/clock, which a cron may call every
// minute, and opens a database connection only when something can fire,
// and once an hour to read the soonest time again. In order:
//
// 1. The kill switch: no fires, and no connection, while it's on.
// 2. A last-worked minute, kept in this process and, best effort, in Next's
//    cache, so other instances skip it too. Next's cache has no atomic set,
//    so a burst at the turn of a minute can still open a few connections
//    when something is due; the run's advisory lock lets one work.
// 3. The soonest time any item comes due, from Next's cache (tag DUE_TAG,
//    keyed by the hour as src/lib/shared-cache.ts keys its others). Not yet
//    reached, or nothing: stop. The first check of each hour misses the
//    cache and reads Postgres, due or not: on an idle site with a cron, 24
//    wakes a day.
//
// Every write that sets a time clears the tag after it commits, and again
// in its own after(), and a run clears it after working and reads the
// soonest time again while the database is awake. A run that read before a
// setter committed can still write the old time after the setter cleared
// it: a fire is then late by at most the hour, inside a back item's window;
// an RSVP's can be missed.

export const DUE_TAG = "due";
export const DUE_CACHE_SECONDS = 60 * 60;

const cachedSoonest = unstable_cache(
  async (_build: string, _bucket: number): Promise<string | null> => {
    const at = await soonestDue(db());
    return at ? at.toISOString() : null;
  },
  ["due-soonest"],
  { tags: [DUE_TAG], revalidate: false },
);

export function soonestCached(): Promise<string | null> {
  return cachedSoonest(buildKey("due"), timeBucket(DUE_CACHE_SECONDS));
}

// Minutes this process claimed in Next's cache: the cached function runs
// only on a miss, so only the instance that filled the entry sees its minute
// here.
const claimed = new Set<number>();
const claimMinute = unstable_cache(
  async (minute: number): Promise<number> => {
    claimed.add(minute);
    return minute;
  },
  ["due-minute"],
  { revalidate: false },
);

// For tests: forget the minute this process last worked.
export function forgetDueMinute(): void {
  minuteStamp.last = null;
  claimed.clear();
}

export type CheckResult = "read_only" | "stamped" | "not_due" | "worked";

export async function checkDue(now: number = Date.now()): Promise<CheckResult> {
  if (isReadOnly()) return "read_only";
  const minute = Math.floor(now / 60_000);
  if (minuteStamp.last === minute) return "stamped";
  minuteStamp.last = minute;
  claimed.delete(minute);
  await claimMinute(minute);
  const mine = claimed.delete(minute);
  if (!mine) return "stamped";
  const soonest = await soonestCached();
  if (soonest === null || Date.parse(soonest) > now) return "not_due";
  const run = await workDue(new Date(now));
  clearDue();
  await soonestCached();
  if (run.fired > 0) kickPushes();
  return "worked";
}

// Clears the cached soonest time. Outside a request (scripts) there's no
// cache to clear.
export function clearDue(): void {
  try {
    revalidateTag(DUE_TAG, { expire: 0 });
  } catch {
    // Nothing to clear outside Next.
  }
}

// After a write that set or changed a time has committed: clear now, and
// once more after the answer, so a run that read before the commit can't
// leave the old soonest time standing for long.
export function dueChanged(): void {
  clearDue();
  try {
    after(() => clearDue());
  } catch {
    // Outside a request: nothing to run it after.
  }
}

