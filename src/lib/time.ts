// How long ago something happened, the way a forum says it: "just now",
// "4m ago", "3h ago", "yesterday", then the date ("Oct 27"), with the year
// once it isn't this year's. Pure: the caller passes "now", so a page computes
// it once per request on the server and tests can pin it. Dates are UTC, the
// zone the exact time in a title is given in.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

export function relativeTime(at: Date, now: Date): string {
  const age = now.getTime() - at.getTime();
  // A time a little ahead of the server's clock (the database's clock can
  // differ slightly) is still "just now", not a negative age.
  if (age < MINUTE) return "just now";
  if (age < HOUR) return `${Math.floor(age / MINUTE)}m ago`;
  if (age < DAY) return `${Math.floor(age / HOUR)}h ago`;
  if (age < 2 * DAY) return "yesterday";
  const date = `${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()}`;
  return at.getUTCFullYear() === now.getUTCFullYear()
    ? date
    : `${date}, ${at.getUTCFullYear()}`;
}

// The exact time, to the second, labelled UTC: "2026-10-27 14:03:09 UTC".
export function exactUtc(at: Date): string {
  return `${at.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}
