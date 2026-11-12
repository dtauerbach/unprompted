import { unstable_rethrow } from "next/navigation";

// What keeps a save on the admin pages from failing quietly. A save that
// never reaches the server, or comes back with nothing, or throws (an old tab
// after a deploy, a dropped connection, a server error), says so beside the
// Save button, and the words typed stay in the box. Words typed and not yet
// saved are also kept in this tab's session storage, so a reload, or a trip
// to sign in, brings them back to the same box instead of losing them, even
// when someone saved newer words meanwhile.

// `saved` and `savedAfter`: the words a save took and the version they were
// typed over. `failed` and `failedAfter`: the words a save didn't take and
// the version they were typed over, so its error shows only while the box
// still holds those words over that version.
export type SaveState = {
  error?: string;
  message?: string;
  saved?: string;
  savedAfter?: number;
  failed?: string;
  failedAfter?: number;
};

export const NOT_SAVED =
  "That didn't save. Your words are still in the box: reload the page, then press Save again.";
// For a button that sends no words: a restore or an undo.
export const NOT_DONE =
  "That didn't go through. Reload the page and try again.";
// The same, when this tab couldn't keep the words through a reload.
export const NOT_SAVED_UNKEPT =
  "That didn't save. Copy your words before you reload the page, then save them again.";
// Added to a refusal when this tab couldn't keep the words through a reload.
export const COPY_FIRST = "Copy your words before you reload the page.";
export const STILL_SAVING =
  "Still saving. If this doesn't finish, reload the page: your words will still be here.";
export const STILL_SAVING_UNKEPT =
  "Still saving. If this doesn't finish, copy your words, then reload the page.";
export const SAVING = "Saving…";
export const UNSAVED = "Not saved yet.";
export const RESTORED =
  "These are your words from before the page reloaded. They aren't saved yet: press Save to keep them.";
export const OVERTAKEN =
  "Newer words were saved while you were typing (see History). The box still holds yours, not saved: press Save to use yours instead.";

// How long a save may take before the box says it's still going.
export const SLOW_SAVE_MS = 15_000;

type Action = (
  prev: SaveState,
  form: FormData,
) => Promise<SaveState | undefined | null>;

// A textarea's value in the page ends lines with \n; the form's copy of it
// may end them with \r\n. Compared with the box, they must read the same.
function text(form: FormData, name: string): string | undefined {
  const v = form.get(name);
  return typeof v === "string" ? v.replace(/\r\n/g, "\n") : undefined;
}

// Wraps a server action so that every way it can end shows something: its
// own answer, or NOT_SAVED. A redirect (to sign in) still happens; the words
// come back from the session's storage afterwards.
export function guardSave(
  action: Action,
): (prev: SaveState, form: FormData) => Promise<SaveState> {
  return async (prev, form) => {
    const body = text(form, "body");
    const after = Number(text(form, "after"));
    const failed =
      body === undefined ? {} : { failed: body, failedAfter: after };
    const broken = body === undefined ? NOT_DONE : NOT_SAVED;
    let r: SaveState | undefined | null;
    try {
      r = await action(prev, form);
    } catch (err) {
      unstable_rethrow(err);
      return { error: broken, ...failed };
    }
    if (!r || (!r.error && !r.message)) return { error: broken, ...failed };
    if (r.error) return { error: r.error, ...failed };
    return {
      message: r.message,
      ...(body === undefined ? {} : { saved: body, savedAfter: after }),
    };
  };
}

// The words in a box are unsaved when they differ from the words showing now
// and aren't the words a save just took over this same version.
export function isUnsaved(
  draft: string,
  showing: string,
  after: number,
  state: SaveState,
): boolean {
  if (draft === showing) return false;
  return !(state.saved === draft && state.savedAfter === after);
}

// The error beside Save, while the box still holds the words it refused over
// the version it refused them over. Once newer words have come in, a refusal
// that said "reload to see them" no longer holds.
export function currentError(
  draft: string,
  after: number,
  state: SaveState,
): string | undefined {
  if (!state.error) return undefined;
  if (state.failed !== undefined && state.failed !== draft) return undefined;
  if (state.failedAfter !== undefined && state.failedAfter !== after)
    return undefined;
  return state.error;
}

export type DraftStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function draftKey(kind: string, id: string): string {
  return `unprompted:unsaved:${kind}:${id}`;
}

export type KeptDraft = { body: string; overtaken: boolean };

// The words left unsaved in this box, if any. `overtaken` when they were
// typed over other words than the ones showing now: someone saved newer
// words, or a deploy changed the built-in ones. They come back either way,
// marked, so a refusal that says "reload" never costs the words.
export function readDraft(
  store: DraftStore | undefined,
  key: string,
  after: number,
  showing: string,
): KeptDraft | undefined {
  try {
    const raw = store?.getItem(key);
    if (!raw) return undefined;
    const v = JSON.parse(raw) as {
      after?: unknown;
      base?: unknown;
      body?: unknown;
    };
    if (typeof v.body !== "string" || v.body === showing) {
      store?.removeItem(key);
      return undefined;
    }
    return { body: v.body, overtaken: v.after !== after || v.base !== showing };
  } catch {
    return undefined;
  }
}

// Keeps unsaved words for this box, with the version and words they were
// typed over (null once newer words came in under them), or forgets them once they're saved or match what's showing.
// False when the words couldn't be kept.
export function keepDraft(
  store: DraftStore | undefined,
  key: string,
  draft: { after: number; base: string | null; body: string },
  unsaved: boolean,
): boolean {
  try {
    if (!store) return !unsaved;
    if (unsaved) store.setItem(key, JSON.stringify(draft));
    else store.removeItem(key);
    return true;
  } catch {
    // Storage may be full, blocked or missing: the box still works.
    return !unsaved;
  }
}

export function sessionStore(): DraftStore | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
}
