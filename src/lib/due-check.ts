import { unstable_cache } from "next/cache";
import { db } from "./db";
import { soonestDue, workDue } from "./due";
import { clearDue, DUE_TAG, minuteStamp } from "./due-kick";
import { offerJobs } from "./job-offers";
import { drainForAWhile, nextDue } from "./push";
import { isReadOnly } from "./read-only";
import { buildKey, timeBucket } from "./shared-cache";
import { FIRE_DEADLINE_MS } from "./wake-adapters/claude-fire";

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
// The same entry keeps the soonest time a waiting push is due (nextDue() in
// src/lib/push.ts), so a push an adapter's gap held past a drain's round
// goes out from here with no other request. A drain that leaves one waiting
// clears the tag.
//
// Every write that sets a time clears the tag after it commits, and again
// in its own after() (dueChanged() in src/lib/due-kick.ts), and a run
// clears it after working and draining, and reads the soonest time again
// while the database is awake. A run cut off before that repeats the next
// minute. A run that read before a setter committed can still
// write the old time after the setter cleared it. For a back item that
// makes a fire late, inside its window. An RSVP's window ends 30 minutes
// after its gathering starts, so near a start the entry is keyed by five
// minutes instead of the hour: while the soonest gathering that could still
// wake anyone starts within DUE_NEAR_MS, or has started, a raced RSVP is
// late by at most five minutes, and missed only if it came due in the last
// five minutes of its window. That costs a read every five minutes from 90
// minutes before a gathering to 30 after, RSVPs or not, which the
// `announce` gate and its daily limit bound.

const HOUR = 60 * 60;
const NEAR = 5 * 60;
// How close a gathering's start must be for the check to read every five
// minutes.
export const DUE_NEAR_MS = 90 * 60 * 1000;
// One deadline for a check that works: its run and the pushes it raised, so
// it ends inside the minute, and inside a route's own time limit. The last
// send it starts can take up to its deadline past it: a push's few
// seconds, or a Claude routine's fire's longer one (FIRE_DEADLINE_MS).
export const DUE_ROUND_MS = 40_000;

// next: the soonest item on the due-list; push: the soonest push held back
// past a drain's round (src/lib/push.ts clears the tag when it leaves one).
type Soonest = {
  next: string | null;
  start: string | null;
  push: string | null;
};

const cachedSoonest = unstable_cache(
  async (_build: string, _span: number, _bucket: number): Promise<Soonest> => {
    const s = await soonestDue(db());
    const push = await nextDue();
    return {
      next: s.next ? s.next.toISOString() : null,
      start: s.start ? s.start.toISOString() : null,
      push: push ? push.toISOString() : null,
    };
  },
  ["due-soonest"],
  { tags: [DUE_TAG], revalidate: false },
);

function read(span: number): Promise<Soonest> {
  return cachedSoonest(buildKey("due"), span, timeBucket(span));
}

// The soonest time an item comes due, and a held push may go, as the cache
// has them: by the hour, or by five minutes near a gathering's start.
export async function soonestCached(
  now: number = Date.now(),
): Promise<{ next: string | null; push: string | null }> {
  let s = await read(HOUR);
  if (s.start !== null && Date.parse(s.start) - now <= DUE_NEAR_MS)
    s = await read(NEAR);
  return { next: s.next, push: s.push };
}

const reached = (at: string | null, now: number) =>
  at !== null && Date.parse(at) <= now;

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
  // Each minute is its own key, read only in that minute: a short life lets
  // the cache drop the old ones rather than keep one a minute for good.
  { revalidate: 120 },
);

// For tests: forget the minute this process last worked.
export function forgetDueMinute(): void {
  minuteStamp.last = null;
  claimed.clear();
}

export type CheckResult = "read_only" | "stamped" | "not_due" | "worked";

export async function checkDue(now: number = Date.now()): Promise<CheckResult> {
  if (isReadOnly()) return "read_only";
  const until = Date.now() + DUE_ROUND_MS;
  const minute = Math.floor(now / 60_000);
  if (minuteStamp.last === minute) return "stamped";
  minuteStamp.last = minute;
  claimed.delete(minute);
  await claimMinute(minute);
  const mine = claimed.delete(minute);
  if (!mine) return "stamped";
  const soonest = await soonestCached(now);
  const due = reached(soonest.next, now);
  const held = reached(soonest.push, now);
  if (!due && !held) return "not_due";
  const fired = due ? (await workDue(new Date(now))).fired : 0;
  // Job offers that came due: an offer nobody answered, a lease that ran
  // out (src/lib/job-offers.ts). They raise wake numbers as fires do.
  // Within the round's deadline, and never stopping the round: a pass
  // that fails leaves its offers due for the next.
  const offered = due
    ? await offerJobs({ until: until - FIRE_DEADLINE_MS })
        .then((r) => r.offered)
        .catch((e: unknown) => {
          console.error(e);
          return 0;
        })
    : 0;
  // The pushes its fires raised, and any held past an earlier round,
  // awaited here within the deadline: this already runs after the answer,
  // with nothing further to run it after. The drain stops under the kill
  // switch too (src/lib/push.ts). A held push another round sent since the
  // cache read costs this one drain that finds nothing.
  const left = until - Date.now();
  if ((fired > 0 || offered > 0 || held) && left > 0)
    await drainForAWhile(undefined, left);
  // Then the next times, read while the database is awake.
  clearDue();
  await soonestCached(now);
  return "worked";
}
