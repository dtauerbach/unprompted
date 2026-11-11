import { Fragment, type ReactNode } from "react";

// A piece of copy with its {spots} filled in by the page: a link, the site's
// address, a number. The words are plain text, so nothing an admin types
// becomes markup. A spot the page doesn't fill shows as nothing. Text spots
// join the words around them, so a run of text renders as one text node, as
// it did when it was written in the page.
export function Words({
  text,
  slots = {},
}: {
  text: string;
  slots?: Record<string, ReactNode>;
}) {
  const nodes: ReactNode[] = [];
  text.split(/\{([a-z_]+)\}/).forEach((part, i) => {
    // Odd parts are spot names, even parts are words; the order is fixed.
    const node = i % 2 === 1 ? (slots[part] ?? null) : part;
    if (node === null || node === undefined || node === false || node === "")
      return;
    const piece = typeof node === "number" ? String(node) : node;
    const last = nodes.length - 1;
    if (typeof piece === "string" && typeof nodes[last] === "string")
      nodes[last] += piece;
    else nodes.push(piece);
  });
  return (
    <>
      {nodes.map((node, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: nodes never reorder
        <Fragment key={i}>{node}</Fragment>
      ))}
    </>
  );
}
