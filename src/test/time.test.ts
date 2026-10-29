import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Timestamp } from "@/components/timestamp";
import { exactUtc, relativeTime } from "@/lib/time";

const NOW = new Date("2026-10-29T12:00:00.000Z");
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function ago(ms: number): string {
  return relativeTime(new Date(NOW.getTime() - ms), NOW);
}

describe("relativeTime", () => {
  it("says just now for under a minute", () => {
    expect(ago(0)).toBe("just now");
    expect(ago(1)).toBe("just now");
    expect(ago(59 * SECOND)).toBe("just now");
    expect(ago(MINUTE - 1)).toBe("just now");
  });

  it("says just now for a time slightly ahead of the clock", () => {
    expect(ago(-5 * SECOND)).toBe("just now");
    expect(ago(-2 * HOUR)).toBe("just now");
  });

  it("counts whole minutes from one minute to the hour", () => {
    expect(ago(MINUTE)).toBe("1m ago");
    expect(ago(MINUTE + 59 * SECOND)).toBe("1m ago");
    expect(ago(4 * MINUTE)).toBe("4m ago");
    expect(ago(HOUR - 1)).toBe("59m ago");
  });

  it("counts whole hours from one hour to the day", () => {
    expect(ago(HOUR)).toBe("1h ago");
    expect(ago(3 * HOUR + 59 * MINUTE)).toBe("3h ago");
    expect(ago(DAY - 1)).toBe("23h ago");
  });

  it("says yesterday from 24 to 48 hours", () => {
    expect(ago(DAY)).toBe("yesterday");
    expect(ago(DAY + 23 * HOUR)).toBe("yesterday");
    expect(ago(2 * DAY - 1)).toBe("yesterday");
  });

  it("gives the date, in UTC, from two days on", () => {
    expect(ago(2 * DAY)).toBe("Oct 27");
    expect(relativeTime(new Date("2026-01-01T00:00:00Z"), NOW)).toBe("Jan 1");
    // 23:30 on the 26th in New York is already the 27th in UTC.
    expect(relativeTime(new Date("2026-10-26T23:30:00-04:00"), NOW)).toBe(
      "Oct 27",
    );
  });

  it("adds the year once it isn't this year's", () => {
    expect(relativeTime(new Date("2025-12-31T23:59:59Z"), NOW)).toBe(
      "Dec 31, 2025",
    );
    expect(relativeTime(new Date("2019-03-05T10:00:00Z"), NOW)).toBe(
      "Mar 5, 2019",
    );
    // Across New Year, a post from two days back is last year's.
    const newYear = new Date("2027-01-01T06:00:00Z");
    expect(relativeTime(new Date("2026-12-30T05:00:00Z"), newYear)).toBe(
      "Dec 30, 2026",
    );
    expect(relativeTime(new Date("2026-12-31T05:00:00Z"), newYear)).toBe(
      "yesterday",
    );
  });

  it("doesn't depend on anything but its arguments", () => {
    const at = new Date(NOW.getTime() - 3 * HOUR);
    expect(relativeTime(at, NOW)).toBe(relativeTime(at, new Date(NOW)));
    expect(relativeTime(at, new Date(NOW.getTime() + DAY))).toBe("yesterday");
  });
});

describe("exactUtc", () => {
  it("gives the time to the second, labelled UTC", () => {
    expect(exactUtc(new Date("2026-10-27T14:03:09.456Z"))).toBe(
      "2026-10-27 14:03:09 UTC",
    );
    expect(exactUtc(new Date("2026-10-27T10:03:09-04:00"))).toBe(
      "2026-10-27 14:03:09 UTC",
    );
  });
});

describe("Timestamp", () => {
  it("renders the relative time in a time element with the exact time", () => {
    const at = new Date("2026-10-29T09:15:00.000Z");
    const html = renderToStaticMarkup(
      createElement(Timestamp, { at, now: NOW }),
    );
    expect(html).toBe(
      '<time dateTime="2026-10-29T09:15:00.000Z" title="2026-10-29 09:15:00 UTC">2h ago</time>',
    );
  });

  it("measures from the time it is rendered when given no now", () => {
    const html = renderToStaticMarkup(
      createElement(Timestamp, { at: new Date(Date.now() - 5 * MINUTE) }),
    );
    expect(html).toMatch(/>5m ago<\/time>$/);
  });
});
