import { unstable_rethrow } from "next/navigation";

// What keeps a save on the admin pages from failing quietly. A save that
// never reaches the server, or comes back with nothing, or throws (an old tab
// after a deploy, a dropped connection, a server error), says so beside the
// Save button, and the words typed stay in the box. Words typed and not yet
// saved are also kept in this tab's session storage, so a reload, or a trip
// to sign in, brings them back to the same box instead of losing them.

export type SaveState = { error?: string; message?: string; saved?: string };

export const NOT_SAVED =
  "That didn't save. Your words are still in the box: reload the page, then press Save again.";
export const STILL_SAVING =
  "Still saving. If this doesn't finish, reload the page: your words will still be here.";
export const UNSAVED = "Not saved yet.";
export const RESTORED =
  "These are your words from before the page reloaded. They aren't saved yet: press Save to keep them.";

// How long a save may take before the box says it's still going.
export const SLOW_SAVE_MS = 15_000;

type Action = (
  prev: SaveState,
  form: FormData,
) => Promise<SaveState | undefined | null>;

// Wraps a server action so that every way it can end shows something: its
// own answer, or NOT_SAVED. A redirect (to sign in) still happens; the words
// come back from the session's storage afterwards. A save that worked
// remembers the words it sent, so the box knows they're saved even before
// the page brings back the new version.
export function guardSave(
  action: Action,
): (prev: SaveState, form: FormData) => Promise<SaveState> {
  return async (prev, form) => {
    const body = form.get("body");
    let r: SaveState | undefined | null;
    try {
      r = await action(prev, form);
    } catch (err) {
      unstable_rethrow(err);
      return { error: NOT_SAVED };
    }
    if (!r || (!r.error && !r.message)) return { error: NOT_SAVED };
    if (r.error) return { error: r.error };
    return {
      message: r.message,
      ...(typeof body === "string" ? { saved: body } : {}),
    };
  };
}

// The words in a box are unsaved when they differ from the words showing now
// and from the last words a save took.
export function isUnsaved(
  draft: string,
  showing: string,
  state: SaveState,
): boolean {
  return draft !== showing && draft !== state.saved;
}

export type DraftStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function draftKey(kind: string, id: string): string {
  return `unprompted:unsaved:${kind}:${id}`;
}

// The words left unsaved in this box, if they were typed over the version
// showing now. Words typed over an older version give way to the newer one.
export function readDraft(
  store: DraftStore | undefined,
  key: string,
  after: number,
  showing: string,
): string | undefined {
  try {
    const raw = store?.getItem(key);
    if (!raw) return undefined;
    const v = JSON.parse(raw) as { after?: unknown; body?: unknown };
    if (v.after !== after || typeof v.body !== "string") {
      store?.removeItem(key);
      return undefined;
    }
    return v.body === showing ? undefined : v.body;
  } catch {
    return undefined;
  }
}

// Keeps unsaved words for this box, or forgets them once they're saved or
// match what's showing.
export function keepDraft(
  store: DraftStore | undefined,
  key: string,
  after: number,
  body: string,
  unsaved: boolean,
): void {
  try {
    if (unsaved) store?.setItem(key, JSON.stringify({ after, body }));
    else store?.removeItem(key);
  } catch {
    // Storage may be full, blocked or missing: the box still works.
  }
}

export function sessionStore(): DraftStore | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
}
