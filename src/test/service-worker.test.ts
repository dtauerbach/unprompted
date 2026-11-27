import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

// The site's service worker (public/sw.js, W1b): a notice opens only a page
// on this site, whatever the push said (Fable's review of W1: "//host" read
// as a path let a notice open another site).

const ORIGIN = "https://unprompted.test";

function load() {
  const listeners: Record<string, (e: unknown) => void> = {};
  const shown: { title: string; opts: { data: { url: string } } }[] = [];
  const opened: string[] = [];
  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      listeners[type] = fn;
    },
    skipWaiting: () => {},
    clients: {
      claim: () => Promise.resolve(),
      matchAll: () => Promise.resolve([]),
      openWindow: (u: string) => {
        opened.push(u);
        return Promise.resolve();
      },
    },
    registration: {
      showNotification: (title: string, opts: { data: { url: string } }) => {
        shown.push({ title, opts });
        return Promise.resolve();
      },
    },
  };
  runInNewContext(readFileSync(join(process.cwd(), "public/sw.js"), "utf8"), {
    self,
    URL,
  });
  const waits: Promise<unknown>[] = [];
  const waitUntil = (p: Promise<unknown>) => waits.push(p);
  return {
    async push(data: unknown) {
      listeners.push?.({
        data: { json: () => data },
        waitUntil,
      });
      await Promise.all(waits);
      return shown.at(-1)?.opts.data.url;
    },
    async click(url: unknown) {
      listeners.notificationclick?.({
        notification: { close: () => {}, data: { url } },
        waitUntil,
      });
      await Promise.all(waits);
      return opened.at(-1);
    },
  };
}

describe("the service worker", () => {
  it("opens a path on this site", async () => {
    const sw = load();
    expect(await sw.push({ title: "t", url: "/account/channels/12" })).toBe(
      "/account/channels/12",
    );
    expect(await sw.click("/account/channels/12")).toBe(
      `${ORIGIN}/account/channels/12`,
    );
  });

  it("opens the account page for anything that isn't one", async () => {
    const sw = load();
    for (const bad of [
      "//evil.example",
      "//evil.example/account",
      "/account//evil.example",
      "https://evil.example/",
      "/\\evil.example",
      "javascript:alert(1)",
      "/account?x=1",
      "account",
      "",
      42,
      null,
    ]) {
      expect(await sw.push({ title: "t", url: bad }), String(bad)).toBe(
        "/account",
      );
      expect(await sw.click(bad), String(bad)).toBe(`${ORIGIN}/account`);
    }
  });
});
