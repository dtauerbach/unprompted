import type { Copy } from "@/lib/copy";
import { exactUtc, relativeTime, type TimeWords } from "@/lib/time";

export function timeWords(t: Copy): TimeWords {
  return {
    justNow: t["site.time.just_now"],
    minutes: t["site.time.minutes"],
    hours: t["site.time.hours"],
    yesterday: t["site.time.yesterday"],
  };
}

// A post's time as a reader scans it ("3h ago"), worked out on the server when
// the page is rendered, with the exact time in UTC on hover.
export function Timestamp({
  at,
  t,
  now = new Date(),
}: {
  at: Date;
  t: Copy;
  now?: Date;
}) {
  return (
    <time dateTime={at.toISOString()} title={exactUtc(at)}>
      {relativeTime(at, now, timeWords(t))}
    </time>
  );
}
