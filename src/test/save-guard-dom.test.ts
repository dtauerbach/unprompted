// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The words page's box, in a browser: a save that throws, hangs, or comes
// back with nothing says so beside Save, the typed words stay in the box,
// and a reload brings them back. This is what an admin saw go wrong: they
// typed, pressed Save, and nothing changed, with nothing said.

type Answer = { error?: string; message?: string } | undefined;
const calls: (string | null)[] = [];
let answer: (body: string | null) => Promise<Answer> = async () => ({
  message: "Saved.",
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
  };
});

const { CopyForm } = await import("@/app/admin/forms");
const { NOT_SAVED, RESTORED, SLOW_SAVE_MS, STILL_SAVING, UNSAVED, draftKey } =
  await import("@/app/admin/save-guard");

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
  answer = async () => ({ message: "Saved." });
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
    answer = async () => ({ message: "Saved." });
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

  it("lets a newer version win over old unsaved words", async () => {
    const first = await draw(PROPS);
    await type(first, "Threads");
    await act(async () => first.root.unmount());
    const again = await draw({ ...PROPS, text: "Board", after: 22 });
    expect(again.box.value).toBe("Board");
    expect(again.note()).toBe("");
  });

  it("says Saving…, holds Save, and says so when a save hangs", async () => {
    vi.useFakeTimers();
    answer = () => new Promise<Answer>(() => {});
    const b = await draw(PROPS);
    await type(b, "Threads");
    await save(b);
    expect(b.note()).toBe("Saving…");
    expect(b.button.disabled).toBe(true);
    await act(async () => vi.advanceTimersByTime(SLOW_SAVE_MS + 10));
    expect(b.note()).toBe(STILL_SAVING);
    expect(b.box.value).toBe("Threads");
    expect(sessionStorage.getItem(STORED)).toContain("Threads");
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
