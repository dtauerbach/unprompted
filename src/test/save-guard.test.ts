import { redirect } from "next/navigation";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CopyForm, RestoreForm } from "@/app/admin/forms";
import {
  type DraftStore,
  draftKey,
  guardSave,
  isUnsaved,
  keepDraft,
  NOT_SAVED,
  readDraft,
  type SaveState,
} from "@/app/admin/save-guard";

// A save on the admin pages either says what it did or says it didn't save:
// never nothing. And words typed and not saved outlive a reload.

function form(body?: string): FormData {
  const f = new FormData();
  f.set("key", "forum.title");
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
  it("passes on what the save said, and remembers the words it took", async () => {
    const save = guardSave(async () => ({ message: "Saved." }));
    expect(await save({}, form("New words"))).toEqual({
      message: "Saved.",
      saved: "New words",
    });
    const same = guardSave(async () => ({
      message: "That's what it already says.",
    }));
    expect(await same({}, form("Forum"))).toEqual({
      message: "That's what it already says.",
      saved: "Forum",
    });
  });

  it("passes on a refusal and claims nothing saved", async () => {
    const save = guardSave(async () => ({ error: "Keep {welcome_post}." }));
    expect(await save({}, form("Gone"))).toEqual({
      error: "Keep {welcome_post}.",
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
      expect(await save({}, form("Lost?"))).toEqual({ error: NOT_SAVED });
    }
  });

  it("says it didn't save when the save comes back with nothing", async () => {
    for (const r of [undefined, null, {}, { message: "" }]) {
      const save = guardSave(async () => r);
      expect(await save({}, form("Lost?")), JSON.stringify(r)).toEqual({
        error: NOT_SAVED,
      });
    }
  });

  it("lets a redirect to sign in go ahead", async () => {
    const save = guardSave(async () => redirect("/sign-in"));
    await expect(save({}, form("Mine"))).rejects.toMatchObject({
      digest: expect.stringContaining("NEXT_REDIRECT"),
    });
  });

  it("takes no words when the form sends none, as a restore doesn't", async () => {
    const save = guardSave(async () => ({ message: "Done." }));
    expect(await save({}, form())).toEqual({ message: "Done." });
  });

  it("tells the admin plainly what to do", () => {
    expect(NOT_SAVED).toMatch(/didn't save/);
    expect(NOT_SAVED).toMatch(/reload/);
    expect(NOT_SAVED).toMatch(/still in the box/);
  });
});

describe("unsaved words", () => {
  const none: SaveState = {};
  it("are words that differ from what's showing and from the last save", () => {
    expect(isUnsaved("Forum", "Forum", none)).toBe(false);
    expect(isUnsaved("Threads", "Forum", none)).toBe(true);
    expect(isUnsaved("Threads", "Forum", { saved: "Threads" })).toBe(false);
    expect(isUnsaved("Threads!", "Forum", { saved: "Threads" })).toBe(true);
    // A refusal saved nothing, so the words stay unsaved.
    expect(isUnsaved("Threads", "Forum", { error: "No." })).toBe(true);
  });
});

describe("keeping unsaved words through a reload", () => {
  const key = draftKey("copy", "site.nav.forum");

  it("names each box apart", () => {
    expect(draftKey("copy", "a")).not.toBe(draftKey("copy", "b"));
    expect(draftKey("copy", "a")).not.toBe(draftKey("bot_text", "a"));
  });

  it("brings back words typed over the version still showing", () => {
    const store = memoryStore();
    keepDraft(store, key, 0, "Threads", true);
    expect(readDraft(store, key, 0, "Forum")).toBe("Threads");
  });

  it("forgets words once they're saved or match what's showing", () => {
    const store = memoryStore();
    keepDraft(store, key, 0, "Threads", true);
    keepDraft(store, key, 0, "Threads", false);
    expect(store.map.size).toBe(0);
    keepDraft(store, key, 0, "Forum", true);
    expect(readDraft(store, key, 0, "Forum")).toBeUndefined();
  });

  it("gives way to a newer version, and drops the old words", () => {
    const store = memoryStore();
    keepDraft(store, key, 3, "Threads", true);
    expect(readDraft(store, key, 4, "Board")).toBeUndefined();
    expect(store.map.size).toBe(0);
  });

  it("ignores what it can't read, and never throws", () => {
    const store = memoryStore();
    store.setItem(key, "{not json");
    expect(readDraft(store, key, 0, "Forum")).toBeUndefined();
    store.setItem(key, JSON.stringify({ after: 0, body: 7 }));
    expect(readDraft(store, key, 0, "Forum")).toBeUndefined();
    expect(readDraft(brokenStore, key, 0, "Forum")).toBeUndefined();
    expect(() => keepDraft(brokenStore, key, 0, "x", true)).not.toThrow();
    expect(() => keepDraft(brokenStore, key, 0, "x", false)).not.toThrow();
    expect(readDraft(undefined, key, 0, "Forum")).toBeUndefined();
    expect(() => keepDraft(undefined, key, 0, "x", true)).not.toThrow();
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
