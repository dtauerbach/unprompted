"use client";

import { useActionState, useEffect, useState } from "react";
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
  COPY_FIRST,
  currentError,
  draftKey,
  guardSave,
  isUnsaved,
  keepDraft,
  NOT_SAVED,
  NOT_SAVED_UNKEPT,
  OVERTAKEN,
  RESTORED,
  readDraft,
  SAVING,
  type SaveState,
  SLOW_SAVE_MS,
  STILL_SAVING,
  STILL_SAVING_UNKEPT,
  sessionStore,
  UNSAVED,
} from "./save-guard";

// What a save or a restore is for: a piece of copy, a text bots read, or one
// of the site's own channels' descriptions.
export type TextKind = "copy" | "bot_text" | "description";

// Each wrapped so a save that throws or comes back empty says so.
const SAVE = {
  copy: guardSave(saveCopyAction),
  bot_text: guardSave(saveBotTextAction),
  description: guardSave(saveDescriptionAction),
};
const RESTORE = {
  copy: guardSave(restoreCopyAction),
  bot_text: guardSave(restoreBotTextAction),
  description: guardSave(restoreDescriptionAction),
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
  if (state.error) return <Warn>{state.error}</Warn>;
  if (state.message) return <Quiet>{state.message}</Quiet>;
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
  const [state, action, pending] = useActionState<SaveState, FormData>(
    SAVE[kind],
    {},
  );
  // The box holds what was typed, so a refused save (a dropped {spot}, say)
  // doesn't put the old words back over it: React resets a form's
  // uncontrolled fields after its action.
  const [draft, setDraft] = useState(text);
  // The version the box last took from the page.
  const [seen, setSeen] = useState({ after, text });
  const [note, setNote] = useState<"restored" | "overtaken" | null>(null);
  const [slow, setSlow] = useState(false);
  const [ready, setReady] = useState(false);
  const [kept, setKept] = useState(true);
  // The words the press of Save now going sent, until it finishes.
  const [sent, setSent] = useState<string | null>(null);
  if (seen.after !== after || seen.text !== text) {
    // New words from the page: this box's own save, or someone else's. The
    // box takes them unless it holds other words the admin typed and hasn't
    // saved, which it keeps. The server may tidy the words a save took (a
    // trailing space), so the box takes the tidied ones in their place.
    const ours = draft === sent || draft === state.saved;
    const typed = draft !== seen.text && draft !== text && !ours;
    setSeen({ after, text });
    if (typed) {
      // Words typed while this box's own save was going aren't overtaken by
      // it: they're just not saved yet.
      setNote(sent === null ? "overtaken" : null);
    } else {
      setDraft(text);
      setNote(null);
    }
  }
  const stored = draftKey(kind, copyKey);
  const unsaved = isUnsaved(draft, text, after, state);
  // Words typed and not yet saved come back after a reload or a trip to sign
  // in. Read once, when the page is first in the browser, where the storage
  // is, before anything is written there; never again, or words a save just
  // took would come back from storage before they're cleared from it.
  useEffect(() => {
    if (ready) return;
    const back = readDraft(sessionStore(), stored, after, text);
    if (back) {
      setDraft(back.body);
      setNote(back.overtaken ? "overtaken" : "restored");
    }
    setReady(true);
  }, [ready, stored, after, text]);
  useEffect(() => {
    if (!pending) setSent(null);
  }, [pending]);
  useEffect(() => {
    if (!ready) return;
    setKept(
      keepDraft(
        sessionStore(),
        stored,
        { after, base: note === "overtaken" ? null : text, body: draft },
        unsaved,
      ),
    );
  }, [ready, stored, after, text, draft, unsaved, note]);
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
    <form action={action} onSubmit={() => setSent(draft)} className="space-y-2">
      <Target kind={kind} id={copyKey} />
      <input type="hidden" name="after" value={after} />
      <textarea
        name="body"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          if (note === "restored" || e.target.value === text) setNote(null);
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
          draft={draft}
          after={after}
          pending={pending}
          slow={slow}
          unsaved={unsaved}
          note={note}
          kept={kept}
        />
      </div>
    </form>
  );
}

// One line beside Save: what the last save did, or that the words in the box
// aren't saved yet. Never nothing while the box holds unsaved words.
function SaveNote({
  state,
  draft,
  after,
  pending,
  slow,
  unsaved,
  note,
  kept,
}: {
  state: SaveState;
  draft: string;
  after: number;
  pending: boolean;
  slow: boolean;
  unsaved: boolean;
  note: "restored" | "overtaken" | null;
  kept: boolean;
}) {
  if (pending) {
    if (!slow) return <Quiet>{SAVING}</Quiet>;
    return <Warn>{kept ? STILL_SAVING : STILL_SAVING_UNKEPT}</Warn>;
  }
  const error = currentError(draft, after, state);
  if (error) {
    if (kept || !unsaved) return <Warn>{error}</Warn>;
    // A reload would lose the words: say so, whatever the refusal says.
    if (error === NOT_SAVED) return <Warn>{NOT_SAVED_UNKEPT}</Warn>;
    return <Warn>{`${error} ${COPY_FIRST}`}</Warn>;
  }
  if (unsaved && note === "overtaken") return <Warn>{OVERTAKEN}</Warn>;
  if (unsaved && note === "restored") return <Warn>{RESTORED}</Warn>;
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
  const [state, action, pending] = useActionState<SaveState, FormData>(
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
