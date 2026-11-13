import { after } from "next/server";
import { isReadOnly } from "./read-only";

// The clock's check, kicked from route() after every answer that wasn't kept
// off the database on purpose (the connector's handshake), and from
// /v1/clock. Its work is in src/lib/due-check.ts, loaded only when it runs,
// so this file, which src/lib/http.ts imports, pulls in nothing else.

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
