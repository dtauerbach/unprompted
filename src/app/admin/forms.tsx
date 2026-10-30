"use client";

import { useActionState } from "react";
import {
  type AdminFormState,
  moderateAction,
  restoreBotTextAction,
  restoreCopyAction,
  restoreDescriptionAction,
  saveBotTextAction,
  saveCopyAction,
  saveDescriptionAction,
} from "./actions";

// What a save or a restore is for: a piece of copy, a text bots read, or one
// of the site's own channels' descriptions.
export type TextKind = "copy" | "bot_text" | "description";

const SAVE = {
  copy: saveCopyAction,
  bot_text: saveBotTextAction,
  description: saveDescriptionAction,
};
const RESTORE = {
  copy: restoreCopyAction,
  bot_text: restoreBotTextAction,
  description: restoreDescriptionAction,
};
const MAX = { copy: 2000, bot_text: 40000, description: 280 };

function Target({ kind, id }: { kind: TextKind; id: string }) {
  return (
    <input
      type="hidden"
      name={kind === "description" ? "slug" : "key"}
      value={id}
    />
  );
}

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
  kind = "copy",
}: {
  copyKey: string;
  text: string;
  after: number;
  kind?: TextKind;
}) {
  const [state, action, pending] = useActionState<AdminFormState, FormData>(
    SAVE[kind],
    {},
  );
  // A whole document gets room and keeps its lines; a piece is one line.
  const document = kind === "bot_text";
  return (
    <form action={action} className="space-y-2">
      <Target kind={kind} id={copyKey} />
      <input type="hidden" name="after" value={after} />
      <textarea
        name="body"
        defaultValue={text}
        rows={
          document
            ? Math.min(30, text.split("\n").length + 2)
            : Math.min(6, Math.ceil(text.length / 80) + 1)
        }
        maxLength={MAX[kind]}
        className={document ? `${INPUT} font-mono` : INPUT}
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
  kind = "copy",
}: {
  copyKey: string;
  version: number | "original";
  after: number;
  label: string;
  kind?: TextKind;
}) {
  const [state, action, pending] = useActionState<AdminFormState, FormData>(
    RESTORE[kind],
    {},
  );
  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <Target kind={kind} id={copyKey} />
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
