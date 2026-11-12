import { redirect } from "next/navigation";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CopyForm, RestoreForm } from "@/app/admin/forms";
import {
  currentError,
  type DraftStore,
  draftKey,
  guardSave,
  isUnsaved,
  keepDraft,
  NOT_DONE,
  NOT_SAVED,
  NOT_SAVED_UNKEPT,
  readDraft,
  type SaveState,
  STILL_SAVING_UNKEPT,
} from "@/app/admin/save-guard";

// A save on the admin pages either says what it did or says it didn't save:
// never nothing. And words typed and not saved outlive a reload.

function form(body?: string, after = "0"): FormData {
  const f = new FormData();
  f.set("key", "forum.title");
  f.set("after", after);
  if (body !== undefined) f.set("body", body);
  return f;
}

function memoryStore(): DraftStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const brokenStore: DraftStore = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("full");
  },
  removeItem: () => {
    throw new Error("blocked");
  },
};

describe("a guarded save", () => {
  it("passes on what the save said, and remembers the words and version it took", async () => {
    const save = guardSave(async () => ({ message: "Saved." }));
    expect(await save({}, form("New words", "20"))).toEqual({
      message: "Saved.",
      saved: "New words",
      savedAfter: 20,
    });
    const same = guardSave(async () => ({
      message: "That's what it already says.",
    }));
    expect(await same({}, form("Forum"))).toEqual({
      message: "That's what it already says.",
      saved: "Forum",
      savedAfter: 0,
    });
  });

  it("passes on a refusal, with the words it refused, and claims nothing saved", async () => {
    const save = guardSave(async () => ({ error: "Keep {welcome_post}." }));
    expect(await save({}, form("Gone"))).toEqual({
      error: "Keep {welcome_post}.",
      failed: "Gone",
      failedAfter: 0,
    });
  });

  it("says it didn't save when the save throws", async () => {
    for (const err of [
      new Error("Server Action was not found on the server"),
      new TypeError("Failed to fetch"),
      new Error("An unexpected response was received from the server."),
      "not even an error",
    ]) {
      const save = guardSave(async () => {
        throw err;
      });
      expect(await save({}, form("Lost?"))).toEqual({
        error: NOT_SAVED,
        failed: "Lost?",
        failedAfter: 0,
      });
    }
  });

  it("says it didn't save when the save comes back with nothing", async () => {
    for (const r of [undefined, null, {}, { message: "" }]) {
      const save = guardSave(async () => r);
      expect(await save({}, form("Lost?")), JSON.stringify(r)).toEqual({
        error: NOT_SAVED,
        failed: "Lost?",
        failedAfter: 0,
      });
    }
  });

  it("lets a redirect to sign in go ahead", async () => {
    const save = guardSave(async () => redirect("/sign-in"));
    await expect(save({}, form("Mine"))).rejects.toMatchObject({
      digest: expect.stringContaining("NEXT_REDIRECT"),
    });
  });

  it("reads lines the form ends with \\r\\n as the box does, with \\n", async () => {
    const save = guardSave(async () => ({ error: "No." }));
    expect(await save({}, form("one\r\ntwo", "4"))).toEqual({
      error: "No.",
      failed: "one\ntwo",
      failedAfter: 4,
    });
    const ok = guardSave(async () => ({ message: "Saved." }));
    expect((await ok({}, form("one\r\ntwo"))).saved).toBe("one\ntwo");
  });

  it("takes no words when the form sends none, as a restore doesn't", async () => {
    const ok = guardSave(async () => ({ message: "Done." }));
    expect(await ok({}, form())).toEqual({ message: "Done." });
    const broken = guardSave(async () => {
      throw new Error("gone");
    });
    expect(await broken({}, form())).toEqual({ error: NOT_DONE });
  });

  it("tells the admin plainly what to do", () => {
    expect(NOT_SAVED).toMatch(/didn't save/);
    expect(NOT_SAVED).toMatch(/reload/);
    expect(NOT_SAVED).toMatch(/still in the box/);
    // Without storage, it never promises a reload keeps the words.
    expect(NOT_SAVED_UNKEPT).toMatch(/Copy your words before you reload/);
    expect(STILL_SAVING_UNKEPT).not.toMatch(/still be here/);
  });
});

describe("unsaved words", () => {
  const none: SaveState = {};
  it("are words that differ from what's showing and from the last save over this version", () => {
    expect(isUnsaved("Forum", "Forum", 0, none)).toBe(false);
    expect(isUnsaved("Threads", "Forum", 0, none)).toBe(true);
    const took = { saved: "Threads", savedAfter: 0 };
    expect(isUnsaved("Threads", "Forum", 0, took)).toBe(false);
    expect(isUnsaved("Threads!", "Forum", 0, took)).toBe(true);
    // Once another version is showing, that old save no longer counts.
    expect(isUnsaved("Threads", "Forum", 7, took)).toBe(true);
    // A refusal saved nothing, so the words stay unsaved.
    expect(isUnsaved("Threads", "Forum", 0, { error: "No." })).toBe(true);
  });
});

describe("the error beside Save", () => {
  it("shows only while the box holds the words it refused, over the version it refused them over", () => {
    const refused: SaveState = {
      error: "No.",
      failed: "Threads",
      failedAfter: 3,
    };
    expect(currentError("Threads", 3, refused)).toBe("No.");
    expect(currentError("Threads!", 3, refused)).toBeUndefined();
    expect(currentError("Forum", 3, refused)).toBeUndefined();
    expect(currentError("Threads", 3, {})).toBeUndefined();
    // Newer words came in: "reload to see them" no longer holds.
    expect(currentError("Threads", 4, refused)).toBeUndefined();
    // An error from a form that sends no words (a restore) always shows.
    expect(currentError("anything", 9, { error: "No." })).toBe("No.");
  });
});

describe("keeping unsaved words through a reload", () => {
  const key = draftKey("copy", "site.nav.forum");
  const over = (after: number, base: string | null, body: string) => ({
    after,
    base,
    body,
  });

  it("names each box apart", () => {
    expect(draftKey("copy", "a")).not.toBe(draftKey("copy", "b"));
    expect(draftKey("copy", "a")).not.toBe(draftKey("bot_text", "a"));
  });

  it("brings back words typed over the version still showing", () => {
    const store = memoryStore();
    expect(keepDraft(store, key, over(0, "Forum", "Threads"), true)).toBe(true);
    expect(readDraft(store, key, 0, "Forum")).toEqual({
      body: "Threads",
      overtaken: false,
    });
  });

  it("forgets words once they're saved or match what's showing", () => {
    const store = memoryStore();
    keepDraft(store, key, over(0, "Forum", "Threads"), true);
    keepDraft(store, key, over(0, "Forum", "Threads"), false);
    expect(store.map.size).toBe(0);
    keepDraft(store, key, over(0, "Forum", "Forum"), true);
    expect(readDraft(store, key, 0, "Forum")).toBeUndefined();
    expect(store.map.size).toBe(0);
  });

  it("brings back words typed over an older version, marked as overtaken", () => {
    // Someone saved version 4 while these were typed over version 3: the
    // refusal says reload, and the reload mustn't cost the words.
    const store = memoryStore();
    keepDraft(store, key, over(3, "Forum", "Threads"), true);
    expect(readDraft(store, key, 4, "Board")).toEqual({
      body: "Threads",
      overtaken: true,
    });
    expect(store.map.size).toBe(1);
  });

  it("marks words typed over built-in words a deploy has since changed", () => {
    const store = memoryStore();
    keepDraft(store, key, over(0, "Forum", "Threads"), true);
    expect(readDraft(store, key, 0, "Forums")?.overtaken).toBe(true);
  });

  it("keeps words already overtaken marked so after another reload", () => {
    const store = memoryStore();
    keepDraft(store, key, over(4, null, "Threads"), true);
    expect(readDraft(store, key, 4, "Board")?.overtaken).toBe(true);
  });

  it("ignores what it can't read, never throws, and says when it couldn't keep words", () => {
    const store = memoryStore();
    store.setItem(key, "{not json");
    expect(readDraft(store, key, 0, "Forum")).toBeUndefined();
    store.setItem(key, JSON.stringify({ after: 0, body: 7 }));
    expect(readDraft(store, key, 0, "Forum")).toBeUndefined();
    expect(readDraft(brokenStore, key, 0, "Forum")).toBeUndefined();
    expect(keepDraft(brokenStore, key, over(0, "a", "x"), true)).toBe(false);
    expect(keepDraft(brokenStore, key, over(0, "a", "x"), false)).toBe(true);
    expect(readDraft(undefined, key, 0, "Forum")).toBeUndefined();
    expect(keepDraft(undefined, key, over(0, "a", "x"), true)).toBe(false);
    expect(keepDraft(undefined, key, over(0, "a", "x"), false)).toBe(true);
  });
});

describe("the box as the page first draws it", () => {
  it("holds the words showing now, with Save and no warning", () => {
    const html = renderToStaticMarkup(
      createElement(CopyForm, {
        copyKey: "site.nav.forum",
        text: "Forum",
        after: 0,
        label: "Tab: forum",
      }),
    );
    expect(html).toMatch(/<textarea[^>]*name="body"[^>]*>Forum<\/textarea>/);
    expect(html).toContain(">Save</button>");
    expect(html).not.toContain("Not saved");
    expect(html).not.toContain("didn&#x27;t save");
    expect(html).toContain('aria-live="polite"');
  });

  it("draws a restore button the same way", () => {
    const html = renderToStaticMarkup(
      createElement(RestoreForm, {
        copyKey: "site.nav.forum",
        version: "original",
        after: 3,
        label: "Use the original",
      }),
    );
    expect(html).toContain(">Use the original</button>");
  });
});
