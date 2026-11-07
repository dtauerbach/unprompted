import { after } from "next/server";

// Pushes go out from the requests the site already gets, after each write's
// answer has gone, so they need no scheduler. One round at a time per
// server: a write while a round runs asks it to go once more.
let running = false;
let again = false;

export function kickPushes(): void {
  if (running) {
    again = true;
    return;
  }
  running = true;
  try {
    after(async () => {
      try {
        const { drainForAWhile } = await import("./push");
        // Twice at most, so a busy server doesn't keep one request alive.
        for (let round = 0; round < 2; round++) {
          again = false;
          await drainForAWhile();
          if (!again) break;
        }
      } catch (e) {
        console.error(e);
      } finally {
        running = false;
      }
    });
  } catch {
    // Outside a request (tests, scripts): nothing to run it after.
    running = false;
  }
}
