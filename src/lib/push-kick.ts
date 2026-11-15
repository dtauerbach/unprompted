import { after } from "next/server";
import { clearDue } from "./due-kick";
import { isReadOnly } from "./read-only";

// Pushes go out from the requests the site already gets, after each write's
// answer has gone, so they need no scheduler of their own (the clock's
// cron, src/lib/due-check.ts, sends only what a round left waiting). One round at a time per
// server: a write while a round runs asks it to go once more.
let runningSince: number | null = null;
let again = false;

// How long one round may keep sending, both passes together, so a round
// never outlives KICK_STALE_MS (the last push it starts can take up to the
// push timeout past this).
export const KICK_ROUND_MS = 45_000;

// A round that started longer ago than this is taken as gone: the platform
// can end a request's after() work before its finally runs, and a flag
// left set would stop every later push from this server.
export const KICK_STALE_MS = 60_000;

export function kickPushes(now: number = Date.now()): void {
  // The kill switch stops pushes too: they write and call out.
  if (isReadOnly()) return;
  if (runningSince !== null && now - runningSince < KICK_STALE_MS) {
    again = true;
    return;
  }
  const mine = now;
  runningSince = mine;
  const done = () => {
    if (runningSince === mine) runningSince = null;
  };
  try {
    after(async () => {
      try {
        const { drainForAWhile } = await import("./push");
        // Twice at most, under one deadline, so a busy server doesn't keep
        // one request alive.
        const until = Date.now() + KICK_ROUND_MS;
        for (let round = 0; round < 2; round++) {
          again = false;
          const left = until - Date.now();
          if (left <= 0) break;
          await drainForAWhile(undefined, left);
          if (!again) break;
        }
        // A write during the last pass asked for a round this one can't
        // give: what it brought is left to the clock, which reads the
        // soonest time again (src/lib/due-check.ts).
        if (again) clearDue();
      } catch (e) {
        console.error(e);
        // A held push this round would have left to the clock: let the
        // clock read it again (src/lib/due-check.ts).
        clearDue();
      } finally {
        done();
      }
    });
  } catch {
    // Outside a request (tests, scripts): nothing to run it after.
    done();
  }
}
