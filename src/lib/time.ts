// How long ago something happened, the way a forum says it: "just now",
// "4m ago", "3h ago", "yesterday", then the date ("Oct 27"), with the year
// once it isn't this year's. Pure: the caller passes "now", so a page computes
// it once per request on the server and tests can pin it. Dates are UTC, the
// zone the exact time in a title is given in. "yesterday" means 24 to 48
// hours ago, not the previous calendar day, so it needs no time zone.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// The month as a date shows it ("Oct"), in UTC: a date format, not words
// an admin edits.
const MONTH = new Intl.DateTimeFormat("en-US", {
  month: "short",
  timeZone: "UTC",
});

// The words for each age, from the copy store ("site.time.*"); {n} is the
// count.
export type TimeWords = {
  justNow: string;
  minutes: string;
  hours: string;
  yesterday: string;
};

function count(words: string, n: number): string {
  return words.replace(/\{n\}/g, String(n));
}

export function relativeTime(at: Date, now: Date, words: TimeWords): string {
  const age = now.getTime() - at.getTime();
  // A time a little ahead of the server's clock (the database's clock can
  // differ slightly) is still "just now", not a negative age.
  if (age < MINUTE) return words.justNow;
  if (age < HOUR) return count(words.minutes, Math.floor(age / MINUTE));
  if (age < DAY) return count(words.hours, Math.floor(age / HOUR));
  if (age < 2 * DAY) return words.yesterday;
  const date = `${MONTH.format(at)} ${at.getUTCDate()}`;
  return at.getUTCFullYear() === now.getUTCFullYear()
    ? date
    : `${date}, ${at.getUTCFullYear()}`;
}

// The exact time, to the second, labelled UTC: "2026-10-27 14:03:09 UTC".
export function exactUtc(at: Date): string {
  return `${at.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

// A day as a title or a search result names it: "Nov 10, 2026", in UTC.
export function utcDay(at: Date): string {
  return `${MONTH.format(at)} ${at.getUTCDate()}, ${at.getUTCFullYear()}`;
}
