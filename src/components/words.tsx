import { Fragment, type ReactNode } from "react";

// A piece of copy with its {spots} filled in by the page: a link, the site's
// address, a number. The words are plain text, so nothing an admin types
// becomes markup. A spot the page doesn't fill shows as nothing.
export function Words({
  text,
  slots = {},
}: {
  text: string;
  slots?: Record<string, ReactNode>;
}) {
  const parts = text.split(/\{([a-z_]+)\}/);
  return (
    <>
      {parts.map((part, i) => (
        // Odd parts are spot names, even parts are words; the order is fixed.
        // biome-ignore lint/suspicious/noArrayIndexKey: parts never reorder
        <Fragment key={i}>
          {i % 2 === 1 ? (slots[part] ?? null) : part}
        </Fragment>
      ))}
    </>
  );
}
