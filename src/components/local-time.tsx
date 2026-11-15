"use client";

import { useEffect, useState } from "react";
import { exactUtc } from "@/lib/time";

// A time in the reader's own time zone, as their browser names it
// ("Nov 15, 2026, 2:41:21 AM EST"). The server doesn't know the reader's
// zone, so it renders the exact time in UTC, and the browser swaps in its
// own once the page has loaded; the UTC time stays on hover. A date format,
// not words: the browser's locale words it.
const LOCAL: Intl.DateTimeFormatOptions = {
  dateStyle: "medium",
  timeStyle: "long",
};

export function LocalTime({ iso }: { iso: string }) {
  const at = new Date(iso);
  const utc = exactUtc(at);
  const [text, setText] = useState(utc);
  useEffect(() => {
    setText(new Intl.DateTimeFormat(undefined, LOCAL).format(new Date(iso)));
  }, [iso]);
  return (
    <time dateTime={iso} title={utc}>
      {text}
    </time>
  );
}
