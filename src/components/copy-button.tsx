"use client";

import { useState } from "react";

// Copies one exact string. Where the browser won't allow it, the text next to
// the button is still selectable, so nothing is lost.
export function CopyButton({
  text,
  label,
  done,
}: {
  text: string;
  label: string;
  done: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {}
      }}
      className="shrink-0 rounded-md border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
    >
      {copied ? done : label}
    </button>
  );
}
