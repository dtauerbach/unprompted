// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The words page's box, in a browser: a save that throws, hangs, or comes
// back with nothing says so beside Save, the typed words stay in the box,
// and a reload brings them back. This is what an admin saw go wrong: they
// typed, pressed Save, and nothing changed, with nothing said.

type Answer =
  | { error?: string; message?: string; version?: number }
  | undefined;
const calls: (string | null)[] = [];
// A save that works makes version 21, the page's next version.
let answer: (body: string | null) => Promise<Answer> = async () => ({
  message: "Saved.",
  version: 21,
});

vi.mock("@/app/admin/actions", () => {
  const save = async (_prev: unknown, form: FormData) => {
    const body = form.get("body");
    calls.push(typeof body === "string" ? body : null);
    return answer(typeof body === "string" ? body : null);
  };
  return {
    saveCopyAction: save,
    saveBotTextAction: save,
    saveDescriptionAction: save,
    restoreCopyAction: save,
    restoreBotTextAction: save,
    restoreDescriptionAction: save,
    moderateAction: save,
    undoCopyAction: save,
    makeCopyKeyAction: save,
    revokeCopyKeyAction: save,
  };
});

const { CopyForm, RestoreForm } = await import("@/app/admin/forms");
const { UndoForm } = await import("@/app/admin/copy-key-forms");
const {
  COPY_FIRST,
  NOT_DONE,
  NOT_SAVED,
  NOT_SAVED_UNKEPT,
  OVERTAKEN,
  RESTORED,
  SLOW_SAVE_MS,
  STILL_SAVING,
  UNSAVED,
  draftKey,
} = await import("@/app/admin/save-guard");

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const PROPS = { copyKey: "site.nav.forum", text: "Forum", after: 0 };
const STORED = draftKey("copy", "site.nav.forum");

type Box = {
  root: Root;
  box: HTMLTextAreaElement;
  form: HTMLFormElement;
  button: HTMLButtonElement;
  note: () => string;
};

const mounted: Root[] = [];

async function draw(props: typeof PROPS): Promise<Box> {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  mounted.push(root);
  await act(async () => root.render(createElement(CopyForm, props)));
  const q = <T extends Element>(s: string) => el.querySelector(s) as T;
  return {
    root,
    box: q("textarea"),
    form: q("form"),
    button: q("button"),
    note: () =>
      (q<HTMLElement>("[aria-live]").textContent ?? "").replace(/^Save/, ""),
  };
}

async function type(b: Box, words: string) {
  const set = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    set?.call(b.box, words);
    b.box.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function save(b: Box) {
  await act(async () => b.form.requestSubmit());
}

beforeEach(() => {
  calls.length = 0;
  sessionStorage.clear();
  answer = async () => ({ message: "Saved.", version: 21 });
});

afterEach(async () => {
  for (const r of mounted.splice(0)) await act(async () => r.unmount());
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("the words page's box", () => {
  it("sends the words typed, and says Saved. when they're saved", async () => {
    const b = await draw(PROPS);
    expect(b.note()).toBe("");
    await type(b, "Threads");
    expect(b.note()).toBe(UNSAVED);
    await save(b);
    expect(calls).toEqual(["Threads"]);
    expect(b.note()).toBe("Saved.");
    expect(b.box.value).toBe("Threads");
    expect(sessionStorage.getItem(STORED)).toBeNull();
    // The page then brings the new version: the box and the note stay.
    await act(async () =>
      b.root.render(
        createElement(CopyForm, { ...PROPS, text: "Threads", after: 21 }),
      ),
    );
    expect(b.box.value).toBe("Threads");
    expect(b.note()).toBe("Saved.");
    await type(b, "Threads!");
    expect(b.note()).toBe(UNSAVED);
  });

  it("takes the words as the server tidied them, and doesn't bring the untidy ones back", async () => {
    // The server trims a trailing space; its answer and the page's new
    // version arrive together.
    const b = await draw(PROPS);
    answer = async () => {
      b.root.render(
        createElement(CopyForm, { ...PROPS, text: "Threads", after: 21 }),
      );
      return { message: "Saved.", version: 21 };
    };
    await type(b, "Threads ");
    await save(b);
    expect(calls).toEqual(["Threads "]);
    expect(b.box.value).toBe("Threads");
    expect(b.note()).toBe("Saved.");
    expect(sessionStorage.getItem(STORED)).toBeNull();
    await act(async () => b.root.unmount());
    const again = await draw({ ...PROPS, text: "Threads", after: 21 });
    expect(again.box.value).toBe("Threads");
    expect(again.note()).toBe("");
  });

  it("does the same when the new version comes after the answer", async () => {
    const b = await draw(PROPS);
    await type(b, "Threads ");
    await save(b);
    await act(async () =>
      b.root.render(
        createElement(CopyForm, { ...PROPS, text: "Threads", after: 21 }),
      ),
    );
    expect(b.box.value).toBe("Threads");
    expect(b.note()).toBe("Saved.");
    expect(sessionStorage.getItem(STORED)).toBeNull();
  });

  it("calls words typed while its own save was going unsaved, not overtaken", async () => {
    let finish: (a: Answer) => void = () => {};
    const b = await draw(PROPS);
    answer = () => new Promise<Answer>((r) => (finish = r));
    await type(b, "Threads");
    await save(b);
    await type(b, "Threads!");
    await act(async () => {
      b.root.render(
        createElement(CopyForm, { ...PROPS, text: "Threads", after: 21 }),
      );
      finish({ message: "Saved.", version: 21 });
    });
    expect(b.box.value).toBe("Threads!");
    expect(b.note()).toBe(UNSAVED);
  });

  it("says it didn't save when the save throws, and keeps the words", async () => {
    answer = async () => {
      throw new Error("Server Action was not found on the server.");
    };
    const b = await draw(PROPS);
    await type(b, "Threads");
    await save(b);
    expect(calls).toEqual(["Threads"]);
    expect(b.note()).toBe(NOT_SAVED);
    expect(b.box.value).toBe("Threads");
    expect(b.button.disabled).toBe(false);
  });

  it("says it didn't save when the save comes back with nothing", async () => {
    answer = async () => undefined;
    const b = await draw(PROPS);
    await type(b, "Threads");
    await save(b);
    expect(b.note()).toBe(NOT_SAVED);
    expect(b.box.value).toBe("Threads");
  });

  it("shows a refusal, and keeps the words", async () => {
    answer = async () => ({ error: "Keep {welcome_post} in the words." });
    const b = await draw(PROPS);
    await type(b, "Threads");
    await save(b);
    expect(b.note()).toBe("Keep {welcome_post} in the words.");
    expect(b.box.value).toBe("Threads");
  });

  it("brings unsaved words back after a reload, and says they aren't saved", async () => {
    answer = async () => {
      throw new TypeError("Failed to fetch");
    };
    const first = await draw(PROPS);
    await type(first, "Threads");
    await save(first);
    await act(async () => first.root.unmount());
    const again = await draw(PROPS);
    expect(again.box.value).toBe("Threads");
    expect(again.note()).toBe(RESTORED);
    answer = async () => ({ message: "Saved.", version: 21 });
    await save(again);
    expect(calls.at(-1)).toBe("Threads");
    expect(again.note()).toBe("Saved.");
    expect(sessionStorage.getItem(STORED)).toBeNull();
  });

  it("keeps unsaved words even when Save was never pressed", async () => {
    const first = await draw(PROPS);
    await type(first, "Threads");
    await act(async () => first.root.unmount());
    const again = await draw(PROPS);
    expect(again.box.value).toBe("Threads");
    expect(again.note()).toBe(RESTORED);
    await type(again, "Forum");
    expect(again.note()).toBe("");
    expect(sessionStorage.getItem(STORED)).toBeNull();
  });

  it("brings words back after a refusal that says reload, though newer words came in", async () => {
    // Someone saved version 22 while these were typed over version 0: the
    // save is refused with "Reload to see it", and the reload keeps them.
    answer = async () => ({
      error:
        "Someone saved a newer version while you were editing. Reload to see it.",
    });
    const first = await draw(PROPS);
    await type(first, "Threads");
    await save(first);
    expect(first.note()).toMatch(/Reload to see it/);
    await act(async () => first.root.unmount());
    const again = await draw({ ...PROPS, text: "Board", after: 22 });
    expect(again.box.value).toBe("Threads");
    expect(again.note()).toBe(OVERTAKEN);
    // And after another reload, still marked.
    await act(async () => again.root.unmount());
    const third = await draw({ ...PROPS, text: "Board", after: 22 });
    expect(third.box.value).toBe("Threads");
    expect(third.note()).toBe(OVERTAKEN);
    answer = async () => ({ message: "Saved.", version: 21 });
    await save(third);
    expect(calls.at(-1)).toBe("Threads");
    expect(third.note()).toBe("Saved.");
  });

  it("keeps typed words when newer words arrive on the page, and says so", async () => {
    const b = await draw(PROPS);
    await type(b, "Threads");
    await act(async () =>
      b.root.render(
        createElement(CopyForm, { ...PROPS, text: "Board", after: 22 }),
      ),
    );
    expect(b.box.value).toBe("Threads");
    expect(b.note()).toBe(OVERTAKEN);
    expect(sessionStorage.getItem(STORED)).toContain("Threads");
  });

  it("keeps its words when someone else's arrive while its save is going, and that save is refused", async () => {
    let finish: (a: Answer) => void = () => {};
    const b = await draw(PROPS);
    answer = () => new Promise<Answer>((r) => (finish = r));
    await type(b, "Threads");
    await save(b);
    // Another box's save brings this piece's newer words, saved elsewhere.
    await act(async () =>
      b.root.render(
        createElement(CopyForm, { ...PROPS, text: "Board", after: 22 }),
      ),
    );
    expect(b.box.value).toBe("Threads");
    await act(async () =>
      finish({
        error:
          "Someone saved a newer version while you were editing. Reload to see it.",
      }),
    );
    expect(b.box.value).toBe("Threads");
    expect(b.note()).toBe(OVERTAKEN);
    expect(sessionStorage.getItem(STORED)).toContain("Threads");
  });

  it("doesn't take an old save for a later one when the same words are typed again", async () => {
    const b = await draw(PROPS);
    await type(b, "Threads");
    await save(b);
    await act(async () =>
      b.root.render(
        createElement(CopyForm, { ...PROPS, text: "Threads", after: 21 }),
      ),
    );
    await act(async () =>
      b.root.render(
        createElement(CopyForm, { ...PROPS, text: "Board", after: 22 }),
      ),
    );
    expect(b.box.value).toBe("Board");
    await type(b, "Threads");
    expect(b.note()).toBe(UNSAVED);
    await act(async () =>
      b.root.render(
        createElement(CopyForm, { ...PROPS, text: "Boards", after: 23 }),
      ),
    );
    expect(b.box.value).toBe("Threads");
    expect(b.note()).toBe(OVERTAKEN);
  });

  it("after a save that changed nothing, says newer words came in when someone else's arrive", async () => {
    answer = async () => ({ message: "That's what it already says." });
    const b = await draw(PROPS);
    await save(b);
    expect(b.note()).toBe("That's what it already says.");
    await type(b, "Forum and more");
    await act(async () =>
      b.root.render(
        createElement(CopyForm, { ...PROPS, text: "Board", after: 22 }),
      ),
    );
    expect(b.box.value).toBe("Forum and more");
    expect(b.note()).toBe(OVERTAKEN);
    expect(JSON.parse(sessionStorage.getItem(STORED) ?? "{}").base).toBeNull();
  });

  it("takes someone else's words over words a save found already showing", async () => {
    answer = async () => ({ message: "That's what it already says." });
    const b = await draw(PROPS);
    await type(b, "Forum ");
    await save(b);
    expect(b.note()).toBe("That's what it already says.");
    await act(async () =>
      b.root.render(
        createElement(CopyForm, { ...PROPS, text: "Board", after: 22 }),
      ),
    );
    expect(b.box.value).toBe("Board");
    expect([OVERTAKEN, UNSAVED]).not.toContain(b.note());
    expect(sessionStorage.getItem(STORED)).toBeNull();
  });

  it("stops saying newer words came in once the box is back to them", async () => {
    const b = await draw(PROPS);
    await type(b, "Threads");
    await act(async () =>
      b.root.render(
        createElement(CopyForm, { ...PROPS, text: "Board", after: 22 }),
      ),
    );
    expect(b.note()).toBe(OVERTAKEN);
    await type(b, "Board");
    expect(b.note()).toBe("");
    await type(b, "Board!");
    expect(b.note()).toBe(UNSAVED);
  });

  it("swaps a refusal that says reload for the newer words, once they've come in", async () => {
    answer = async () => ({
      error:
        "Someone saved a newer version while you were editing. Reload to see it.",
    });
    const b = await draw(PROPS);
    await type(b, "Threads");
    await save(b);
    expect(b.note()).toMatch(/Reload to see it/);
    await act(async () =>
      b.root.render(
        createElement(CopyForm, { ...PROPS, text: "Board", after: 22 }),
      ),
    );
    expect(b.box.value).toBe("Threads");
    expect(b.note()).toBe(OVERTAKEN);
  });

  it("keeps refused words when newer words come in, even with nowhere to store them", async () => {
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("full");
      });
    answer = async () => ({ error: "Keep {welcome_post} in the words." });
    const b = await draw(PROPS);
    await type(b, "Threads");
    await save(b);
    await act(async () =>
      b.root.render(
        createElement(CopyForm, { ...PROPS, text: "Board", after: 22 }),
      ),
    );
    expect(b.box.value).toBe("Threads");
    expect(b.note()).toBe(OVERTAKEN);
    setItem.mockRestore();
  });

  it("takes newer words when the box holds nothing typed", async () => {
    const b = await draw(PROPS);
    await act(async () =>
      b.root.render(
        createElement(CopyForm, { ...PROPS, text: "Board", after: 22 }),
      ),
    );
    expect(b.box.value).toBe("Board");
    expect(b.note()).toBe("");
  });

  it("says Not saved yet when saved words are typed again over a later version", async () => {
    const b = await draw(PROPS);
    await type(b, "Threads");
    await save(b);
    await act(async () =>
      b.root.render(
        createElement(CopyForm, { ...PROPS, text: "Threads", after: 21 }),
      ),
    );
    // Undone elsewhere: the page shows the old words again, as version 23.
    await act(async () =>
      b.root.render(
        createElement(CopyForm, { ...PROPS, text: "Forum", after: 23 }),
      ),
    );
    expect(b.box.value).toBe("Forum");
    await type(b, "Threads");
    expect(b.note()).toBe(UNSAVED);
    expect(sessionStorage.getItem(STORED)).toContain("Threads");
  });

  it("drops a refusal once the words it refused are gone from the box", async () => {
    answer = async () => ({ error: "Keep {welcome_post} in the words." });
    const b = await draw(PROPS);
    await type(b, "Threads");
    await save(b);
    expect(b.note()).toBe("Keep {welcome_post} in the words.");
    await type(b, "Threads, again");
    expect(b.note()).toBe(UNSAVED);
    await type(b, "Forum");
    expect(b.note()).toBe("");
  });

  it("doesn't promise a reload keeps the words when this tab can't store them", async () => {
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("full");
      });
    answer = async () => {
      throw new Error("gone");
    };
    const b = await draw(PROPS);
    await type(b, "Threads");
    await save(b);
    expect(b.note()).toBe(NOT_SAVED_UNKEPT);
    expect(b.box.value).toBe("Threads");
    // A refusal that says reload says to copy the words first, too.
    answer = async () => ({
      error:
        "Someone saved a newer version while you were editing. Reload to see it.",
    });
    await save(b);
    expect(b.note()).toBe(
      `Someone saved a newer version while you were editing. Reload to see it. ${COPY_FIRST}`,
    );
    setItem.mockRestore();
  });

  it("says Saving…, holds Save, and says so when a save hangs", async () => {
    vi.useFakeTimers();
    // React holds every later action on the page behind one still running,
    // so this one ends before the test does.
    let finish: (a: Answer) => void = () => {};
    answer = () =>
      new Promise<Answer>((resolve) => {
        finish = resolve;
      });
    const b = await draw(PROPS);
    await type(b, "Threads");
    await save(b);
    expect(b.note()).toBe("Saving…");
    expect(b.button.disabled).toBe(true);
    await act(async () => vi.advanceTimersByTime(SLOW_SAVE_MS + 10));
    expect(b.note()).toBe(STILL_SAVING);
    expect(b.box.value).toBe("Threads");
    expect(sessionStorage.getItem(STORED)).toContain("Threads");
    await act(async () => finish({ message: "Saved.", version: 21 }));
    expect(b.note()).toBe("Saved.");
  });

  it("keeps words a hung save holds as typed over the older words, so a reload marks them overtaken", async () => {
    let finish: (a: Answer) => void = () => {};
    answer = () =>
      new Promise<Answer>((resolve) => {
        finish = resolve;
      });
    const b = await draw(PROPS);
    await type(b, "Threads");
    await save(b);
    // Someone else's words come in while the save hangs.
    await act(async () =>
      b.root.render(
        createElement(CopyForm, { ...PROPS, text: "Board", after: 22 }),
      ),
    );
    expect(b.box.value).toBe("Threads");
    expect(JSON.parse(sessionStorage.getItem(STORED) ?? "{}")).toEqual({
      after: 0,
      base: "Forum",
      body: "Threads",
    });
    // The admin reloads, as the page says to when a save hangs.
    await act(async () => b.root.unmount());
    await act(async () => finish(undefined));
    const again = await draw({ ...PROPS, text: "Board", after: 22 });
    expect(again.box.value).toBe("Threads");
    expect(again.note()).toBe(OVERTAKEN);
  });

  it("keeps each box's words apart", async () => {
    const a = await draw(PROPS);
    const other = await draw({
      ...PROPS,
      copyKey: "site.nav.play",
      text: "Play",
    });
    await type(a, "Threads");
    expect(other.note()).toBe("");
    expect(other.box.value).toBe("Play");
    expect(
      sessionStorage.getItem(draftKey("copy", "site.nav.play")),
    ).toBeNull();
  });
});

describe("the restore and undo buttons", () => {
  async function drawButton(el: ReturnType<typeof createElement>) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    mounted.push(root);
    await act(async () => root.render(el));
    return {
      press: () => act(async () => host.querySelector("form")?.requestSubmit()),
      text: () => host.textContent ?? "",
    };
  }

  it("say it didn't save when the save throws or comes back empty", async () => {
    for (const fail of [
      async () => {
        throw new Error("gone");
      },
      async () => undefined,
    ]) {
      answer = fail;
      const restore = await drawButton(
        createElement(RestoreForm, {
          copyKey: "site.nav.forum",
          version: "original",
          after: 3,
          label: "Use the original",
        }),
      );
      await restore.press();
      expect(restore.text()).toContain(NOT_DONE);
      const undo = await drawButton(createElement(UndoForm, { version: 3 }));
      await undo.press();
      expect(undo.text()).toContain(NOT_DONE);
    }
  });

  it("pass on what the save said", async () => {
    answer = async () => ({ message: "Undone." });
    const undo = await drawButton(createElement(UndoForm, { version: 3 }));
    await undo.press();
    expect(undo.text()).toContain("Undone.");
  });
});
