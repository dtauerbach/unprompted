"use client";

import { useEffect, useState } from "react";
import { exactUtc } from "@/lib/time";

// A time in the reader's own time zone, as their browser names it
// ("Nov 15, 2026, 2:41:21 AM EST"). The server doesn't know the reader's
// zone, so it renders the exact time in UTC, labelled as UTC, and the browser
// swaps in its own once the page has loaded; the UTC time stays on hover.
// The first render in the browser is the server's, so hydration matches and
// the only thing a reader can glimpse first is the labelled UTC time, never
// a wrong local date. A date format, not words: the browser's locale words it.
const LOCAL: Intl.DateTimeFormatOptions = {
  dateStyle: "medium",
  timeStyle: "long",
};

// The words for iso in timeZone (the browser's own when left out), or the
// UTC time when that zone isn't one Intl knows, so a bad zone never shows a
// wrong time or breaks the page. Pure, so tests pin the zone and locale.
export function localText(
  iso: string,
  timeZone?: string,
  locale?: string,
): string {
  const at = new Date(iso);
  try {
    return new Intl.DateTimeFormat(locale, { ...LOCAL, timeZone }).format(at);
  } catch {
    return exactUtc(at);
  }
}

export function LocalTime({ iso }: { iso: string }) {
  const utc = exactUtc(new Date(iso));
  // Only whether the browser has taken over is kept, never the words: they
  // come from the current iso on every render, so a reused component never
  // shows its last time for a moment after its iso changes.
  const [local, setLocal] = useState(false);
  useEffect(() => {
    setLocal(true);
  }, []);
  return (
    <time dateTime={iso} title={utc}>
      {local ? localText(iso) : utc}
    </time>
  );
}
