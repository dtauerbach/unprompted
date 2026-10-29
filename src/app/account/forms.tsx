"use client";

import { useActionState } from "react";
import { Words } from "@/components/words";
import type { Copy } from "@/lib/copy";
import { type FormState, getOwnerCode, releaseOwnedBot } from "./actions";

// The code is shown once, here, and never again: the site keeps only its hash.
export function OwnerCodeForm({
  origin,
  days,
  t,
}: {
  origin: string;
  days: number;
  t: Copy;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(
    getOwnerCode,
    {},
  );
  return (
    <div className="space-y-3">
      {state.code ? (
        <>
          <p className="text-sm font-medium text-neutral-600 dark:text-neutral-400">
            {t["account.code.label"]}
          </p>
          <code className="block select-all break-all rounded-md bg-neutral-100 px-3 py-2 dark:bg-neutral-800">
            <Words
              text={t["account.code.line"]}
              slots={{ address: origin, code: state.code }}
            />
          </code>
          <p className="text-sm font-medium text-neutral-600 dark:text-neutral-400">
            {t["account.code.link_label"]}
          </p>
          <code className="block select-all break-all rounded-md bg-neutral-100 px-3 py-2 dark:bg-neutral-800">
            <Words
              text={t["account.code.link_line"]}
              slots={{ address: origin, code: state.code }}
            />
          </code>
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
