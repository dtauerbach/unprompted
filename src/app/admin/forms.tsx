"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { MAX_BOT_TEXT } from "@/lib/bot-text-limit";
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
import {
  draftKey,
  guardSave,
  isUnsaved,
  keepDraft,
  RESTORED,
  readDraft,
  type SaveState,
  SLOW_SAVE_MS,
  STILL_SAVING,
  sessionStore,
  UNSAVED,
} from "./save-guard";

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
const MAX = { copy: 2000, bot_text: MAX_BOT_TEXT, description: 280 };

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
  label,
}: {
  copyKey: string;
  text: string;
  after: number;
  kind?: TextKind;
  // What the box holds, for a screen reader, where the page shows it nearby.
  label?: string;
}) {
  const save = useMemo(() => guardSave(SAVE[kind]), [kind]);
  const [state, action, pending] = useActionState<SaveState, FormData>(
    save,
    {},
  );
  // The box holds what was typed, so a refused save (a dropped {spot}, say)
  // doesn't put the old words back over it: React resets a form's
  // uncontrolled fields after its action. A newer version from the server
  // starts the box again from its words.
  const [draft, setDraft] = useState(text);
  const [version, setVersion] = useState(after);
  const [restored, setRestored] = useState(false);
  const [slow, setSlow] = useState(false);
  if (version !== after) {
    setVersion(after);
    setDraft(text);
    setRestored(false);
  }
  const stored = draftKey(kind, copyKey);
  const unsaved = isUnsaved(draft, text, state);
  // Words typed and not yet saved come back after a reload or a trip to sign
  // in. Read once the page is in the browser, where the storage is.
  useEffect(() => {
    const kept = readDraft(sessionStore(), stored, after, text);
    if (kept === undefined) return;
    setDraft(kept);
    setRestored(true);
  }, [stored, after, text]);
  useEffect(() => {
    keepDraft(sessionStore(), stored, after, draft, unsaved);
  }, [stored, after, draft, unsaved]);
  useEffect(() => {
    if (!pending) {
      setSlow(false);
      return;
    }
    const timer = setTimeout(() => setSlow(true), SLOW_SAVE_MS);
    return () => clearTimeout(timer);
  }, [pending]);
  // A whole document gets room and keeps its lines; a piece is one line.
  const document = kind === "bot_text";
  return (
    <form action={action} className="space-y-2">
      <Target kind={kind} id={copyKey} />
      <input type="hidden" name="after" value={after} />
      <textarea
        name="body"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setRestored(false);
        }}
        rows={
          document
            ? Math.min(30, text.split("\n").length + 2)
            : Math.min(6, Math.ceil(text.length / 80) + 1)
        }
        maxLength={MAX[kind]}
        aria-label={label}
        className={document ? `${INPUT} font-mono` : INPUT}
      />
      <div className="flex flex-wrap items-center gap-3" aria-live="polite">
        <button type="submit" disabled={pending} className={BUTTON}>
          Save
        </button>
        <SaveNote
          state={state}
          pending={pending}
          slow={slow}
          unsaved={unsaved}
          restored={restored}
        />
      </div>
    </form>
  );
}

// One line beside Save: what the last save did, or that the words in the box
// aren't saved yet. Never nothing while the box holds unsaved words.
function SaveNote({
  state,
  pending,
  slow,
  unsaved,
  restored,
}: {
  state: SaveState;
  pending: boolean;
  slow: boolean;
  unsaved: boolean;
  restored: boolean;
}) {
  if (pending)
    return slow ? <Warn>{STILL_SAVING}</Warn> : <Quiet>Saving…</Quiet>;
  if (state.error) return <Warn>{state.error}</Warn>;
  if (restored && unsaved) return <Warn>{RESTORED}</Warn>;
  if (unsaved) return <Warn>{UNSAVED}</Warn>;
  if (state.message) return <Quiet>{state.message}</Quiet>;
  return null;
}

function Warn({ children }: { children: string }) {
  return (
    <span className="text-sm text-amber-700 dark:text-amber-300">
      {children}
    </span>
  );
}

function Quiet({ children }: { children: string }) {
  return (
    <span className="text-sm text-neutral-600 dark:text-neutral-400">
      {children}
    </span>
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
  const restore = useMemo(() => guardSave(RESTORE[kind]), [kind]);
  const [state, action, pending] = useActionState<SaveState, FormData>(
    restore,
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
