import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LocalTime, localText } from "@/components/local-time";

// The times on the peek-in page (src/components/local-time.tsx): the server
// renders the exact UTC time, labelled, and the browser swaps in the
// reader's own zone. These pin the zone and the locale, with the cases from
// the review checklist: UTC, a half-hour offset, a reader late in the evening
// in New York whose local date is a day behind UTC, both daylight saving
// changes, and a zone Intl doesn't know.

const en = (iso: string, zone?: string) => localText(iso, zone, "en-US");

describe("a time in the reader's own zone", () => {
  it("names the reader's own date and time in each zone", () => {
    expect(en("2026-11-15T18:45:00Z", "UTC")).toBe(
      "Nov 15, 2026, 6:45:00 PM UTC",
    );
    // Half an hour ahead of a whole hour, and over midnight into the 16th.
    expect(en("2026-11-15T18:45:00Z", "Asia/Kolkata")).toBe(
      "Nov 16, 2026, 12:15:00 AM GMT+5:30",
    );
    // 23:30 in New York is already the next day in UTC.
    expect(en("2026-11-16T04:30:00Z", "America/New_York")).toBe(
      "Nov 15, 2026, 11:30:00 PM EST",
    );
  });

  it("follows the daylight saving changes, in order", () => {
    // Spring: 01:59 EST is followed a minute later by 03:00 EDT.
    expect(en("2026-03-08T06:59:00Z", "America/New_York")).toBe(
      "Mar 8, 2026, 1:59:00 AM EST",
    );
    expect(en("2026-03-08T07:00:00Z", "America/New_York")).toBe(
      "Mar 8, 2026, 3:00:00 AM EDT",
    );
    // Autumn: 01:30 comes twice, first in EDT, then in EST, so the zone's
    // name is what tells the two apart.
    expect(en("2026-11-01T05:30:00Z", "America/New_York")).toBe(
      "Nov 1, 2026, 1:30:00 AM EDT",
    );
    expect(en("2026-11-01T06:30:00Z", "America/New_York")).toBe(
      "Nov 1, 2026, 1:30:00 AM EST",
    );
  });

  it("falls back to the labelled UTC time for a zone it doesn't know", () => {
    expect(en("2026-11-15T18:45:00Z", "Not/AZone")).toBe(
      "2026-11-15 18:45:00 UTC",
    );
    expect(en("2026-11-15T18:45:00Z", "")).toBe("2026-11-15 18:45:00 UTC");
  });

  it("renders the labelled UTC time on the server, the original instant kept", () => {
    const html = renderToStaticMarkup(
      createElement(LocalTime, { iso: "2026-11-16T04:30:00.000Z" }),
    );
    // What the browser's first render shows too (its state starts there),
    // so hydration matches and no local date shows before the swap.
    expect(html).toBe(
      '<time dateTime="2026-11-16T04:30:00.000Z" title="2026-11-16 04:30:00 UTC">2026-11-16 04:30:00 UTC</time>',
    );
  });
});
