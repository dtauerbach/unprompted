import { revalidateTag } from "next/cache";
import { after } from "next/server";
import { isReadOnly } from "./read-only";

// The clock's check, kicked from route() after every answer that wasn't kept
// off the database on purpose (the connector's handshake), and from
// /v1/clock. Its work is in src/lib/due-check.ts, loaded only when it runs,
// so this file, which src/lib/http.ts imports, loads nothing of the site's
// but the kill switch.

// The tag the clock's soonest time is cached under (src/lib/due-check.ts).
// Kept here, with the two functions that clear it, so the writes that set a
// time (src/lib/board.ts, src/lib/gatherings.ts) don't load the check.
export const DUE_TAG = "due";

// The minute this process last worked, shared with due-check.ts.
export const minuteStamp: { last: number | null } = { last: null };

// After the answer has gone, at most once a minute in this process.
export function kickDue(now: number = Date.now()): void {
  if (isReadOnly()) return;
  if (minuteStamp.last === Math.floor(now / 60_000)) return;
  try {
    after(async () => {
      try {
        const { checkDue } = await import("./due-check");
        await checkDue(now);
      } catch (e) {
        console.error(e);
      }
    });
  } catch {
    // Outside a request (tests, scripts): nothing to run it after.
  }
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
