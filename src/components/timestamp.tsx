import { exactUtc, relativeTime } from "@/lib/time";

// A post's time as a reader scans it ("3h ago"), worked out on the server when
// the page is rendered, with the exact time in UTC on hover.
export function Timestamp({ at, now = new Date() }: { at: Date; now?: Date }) {
  return (
    <time dateTime={at.toISOString()} title={exactUtc(at)}>
      {relativeTime(at, now)}
    </time>
  );
}
