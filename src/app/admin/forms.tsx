"use client";

import { useActionState } from "react";
import {
  type AdminFormState,
  moderateAction,
  restoreCopyAction,
  saveCopyAction,
} from "./actions";

const BUTTON =
  "rounded-md border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-800";
const INPUT =
  "w-full rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900";

function Result({ state }: { state: AdminFormState }) {
  if (state.error)
    return (
      <span className="text-sm text-amber-700 dark:text-amber-300">
        {state.error}
      </span>
    );
  if (state.message)
    return (
      <span className="text-sm text-neutral-600 dark:text-neutral-400">
        {state.message}
      </span>
    );
  return null;
}

export function CopyForm({
  copyKey,
  text,
  after,
}: {
  copyKey: string;
  text: string;
  after: number;
}) {
  const [state, action, pending] = useActionState<AdminFormState, FormData>(
    saveCopyAction,
    {},
  );
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="key" value={copyKey} />
      <input type="hidden" name="after" value={after} />
      <textarea
        name="body"
        defaultValue={text}
        rows={Math.min(6, Math.ceil(text.length / 80) + 1)}
        maxLength={2000}
        className={INPUT}
      />
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={BUTTON}>
          Save
        </button>
        <Result state={state} />
      </div>
    </form>
  );
}

export function RestoreForm({
  copyKey,
  version,
  after,
  label,
}: {
  copyKey: string;
  version: number | "original";
  after: number;
  label: string;
}) {
  const [state, action, pending] = useActionState<AdminFormState, FormData>(
    restoreCopyAction,
    {},
  );
  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="key" value={copyKey} />
      <input type="hidden" name="version" value={version} />
      <input type="hidden" name="after" value={after} />
      <button type="submit" disabled={pending} className={BUTTON}>
        {label}
      </button>
      <Result state={state} />
    </form>
  );
}

// One moderator lever. `target` is fixed for a button next to a post, or
// typed when `ask` names what to type. `lengths`, for a silence, asks how
// long.
export function ModerateForm({
  op,
  label,
  target,
  ask,
  lengths,
  danger,
}: {
  op: string;
  label: string;
  target?: string;
  ask?: string;
  lengths?: { hours: number; label: string }[];
  danger?: boolean;
}) {
  const [state, action, pending] = useActionState<AdminFormState, FormData>(
    moderateAction,
    {},
  );
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="op" value={op} />
      {target !== undefined ? (
        <input type="hidden" name="target" value={target} />
      ) : ask ? (
        <input
          name="target"
          placeholder={ask}
          aria-label={ask}
          required
          className={`${INPUT} max-w-40`}
        />
      ) : null}
      {lengths && (
        <select
          name="hours"
          aria-label="How long"
          defaultValue={lengths[Math.floor(lengths.length / 2)]?.hours}
          className={`${INPUT} max-w-32`}
        >
          {lengths.map((l) => (
            <option key={l.hours} value={l.hours}>
              for {l.label}
            </option>
          ))}
        </select>
      )}
      <input
        name="reason"
        placeholder="Reason, kept for the moderators"
        aria-label="Reason, kept for the moderators"
        required
        maxLength={280}
        className={`${INPUT} max-w-sm`}
      />
      <button
        type="submit"
        disabled={pending}
        className={
          danger
            ? `${BUTTON} border-red-400 text-red-700 dark:border-red-800 dark:text-red-300`
            : BUTTON
        }
      >
        {label}
      </button>
      <Result state={state} />
    </form>
  );
}
