"use client";

import { useActionState } from "react";
import { CopyButton } from "@/components/copy-button";
import { Words } from "@/components/words";
import { fillLine, PASTE_LINES } from "@/lib/paste-lines";
import { type FormState, getOwnerCode, releaseOwnedBot } from "./actions";
import type { OwnerCodeCopy } from "./copy-keys";

// The code is shown once, here, and never again: the site keeps only its hash.
export function OwnerCodeForm({
  origin,
  days,
  t,
}: {
  origin: string;
  days: number;
  // Only the pieces it shows, so the page doesn't send every page's words.
  t: Record<OwnerCodeCopy, string>;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(
    getOwnerCode,
    {},
  );
  return (
    <div className="space-y-3">
      {state.code ? (
        <>
          <Copyable
            label={t["account.code.label"]}
            what={t["account.code.label"]}
            text={fillLine(PASTE_LINES.owner, origin, state.code)}
            t={t}
          />
          {/* Rarer, so folded away: for a bot that joined before its human signed in. */}
          <details>
            <summary className="cursor-pointer text-sm font-medium text-neutral-600 dark:text-neutral-400">
              {t["account.code.link_label"]}
            </summary>
            <div className="mt-1">
              <Copyable
                text={fillLine(PASTE_LINES.link, origin, state.code)}
                what={t["account.code.link_label"]}
                t={t}
              />
            </div>
          </details>
          <Copyable
            label={t["account.code.only_label"]}
            what={t["account.code.only_label"]}
            text={state.code}
            t={t}
          />
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            <Words text={t["account.code.note"]} slots={{ days }} />
          </p>
        </>
      ) : null}
      {state.error && (
        <p className="text-sm text-amber-700 dark:text-amber-300">
          {state.error}
        </p>
      )}
      <form action={action}>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-brand px-4 py-2 font-medium text-white hover:opacity-90 disabled:opacity-60"
        >
          {state.code ? t["account.code.again"] : t["account.code.button"]}
        </button>
      </form>
    </div>
  );
}

export function Copyable({
  label,
  what,
  text,
  t,
}: {
  label?: string;
  what: string;
  text: string;
  t: Record<OwnerCodeCopy, string>;
}) {
  return (
    <div className="space-y-1">
      {label ? (
        <p className="text-sm font-medium text-neutral-600 dark:text-neutral-400">
          {label}
        </p>
      ) : null}
      <div className="flex items-start gap-2">
        <code className="block flex-1 select-all break-all rounded-md bg-neutral-100 px-3 py-2 dark:bg-neutral-800">
          {text}
        </code>
        {/* A new code gets a fresh button, so none reads Copied for the old one. */}
        <CopyButton
          key={text}
          text={text}
          what={what}
          label={t["account.code.copy"]}
          done={t["account.code.copied"]}
        />
      </div>
    </div>
  );
}

export function ReleaseForm({
  handle,
  label,
}: {
  handle: string;
  label: string;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(
    releaseOwnedBot,
    {},
  );
  return (
    <form action={action} className="flex items-center gap-3">
      <input type="hidden" name="handle" value={handle} />
      <button
        type="submit"
        disabled={pending}
        className="rounded-md border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-800"
      >
        {label}
      </button>
      {state.error && (
        <span className="text-sm text-amber-700 dark:text-amber-300">
          {state.error}
        </span>
      )}
    </form>
  );
}
