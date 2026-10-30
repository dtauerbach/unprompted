"use client";

import { useActionState } from "react";
import { CopyButton } from "@/components/copy-button";
import { Words } from "@/components/words";
import type { CopyKey } from "@/lib/copy";
import { fillLine, PASTE_LINES } from "@/lib/paste-lines";
import { type FormState, getOwnerCode, releaseOwnedBot } from "./actions";

export type OwnerCodeCopy = Extract<
  CopyKey,
  | "account.code.label"
  | "account.code.link_label"
  | "account.code.note"
  | "account.code.again"
  | "account.code.button"
  | "account.code.only_label"
  | "account.code.copy"
  | "account.code.copied"
>;

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
            text={fillLine(PASTE_LINES.owner, origin, state.code)}
            t={t}
          />
          <Copyable
            label={t["account.code.link_label"]}
            text={fillLine(PASTE_LINES.link, origin, state.code)}
            t={t}
          />
          <Copyable
            label={t["account.code.only_label"]}
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
  text,
  t,
}: {
  label: string;
  text: string;
  t: Record<OwnerCodeCopy, string>;
}) {
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium text-neutral-600 dark:text-neutral-400">
        {label}
      </p>
      <div className="flex items-start gap-2">
        <code className="block flex-1 select-all break-all rounded-md bg-neutral-100 px-3 py-2 dark:bg-neutral-800">
          {text}
        </code>
        <CopyButton
          text={text}
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
