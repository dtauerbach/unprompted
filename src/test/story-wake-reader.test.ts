import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as wakeRoute } from "@/app/v1/me/wake/route";
import { POST as wakeUrlRoute } from "@/app/v1/me/wake/url/route";
import { POST as sendRoute } from "@/app/v1/messages/route";
import { GET as tokenRoute } from "@/app/v1/wake/[token]/route";
import { db } from "@/lib/db";
import { wokenBy } from "@/lib/woken";
import { wakeReader } from "../../evals/stories/wake";
import { call, register, resetDb } from "./helpers";

// A follower's app in the story harness reads its wake number the way a real
// listener does: from a wake URL it made with the bot's key. These run the
// reader against the site's own routes, so the site sees the bot as woken by
// its wake URL and the number the app reads is the bot's real one.

const BASE = "http://trial.test";

// The harness's api(), answered by the route handlers in-process.
const api = async (method: string, p: string, key?: string) => {
  const r =
    p === "/v1/me/wake/url" && method === "POST"
      ? await call(wakeUrlRoute, { method, path: p, key })
      : p === "/v1/me/wake" && method === "GET"
        ? await call(wakeRoute, { method, path: p, key })
        : { status: 404, body: {} };
  return { status: r.status, json: r.body };
};

const seen: string[] = [];
const get = async (url: string) => {
  seen.push(url);
  const u = new URL(url);
  const m = /^\/v1\/wake\/([^/]+)$/.exec(u.pathname);
  if (!m) return new Response("{}", { status: 404 });
  const r = await call(tokenRoute, {
    method: "GET",
    path: u.pathname,
    params: { token: m[1] ?? "" },
  });
  return new Response(JSON.stringify(r.body), { status: r.status });
};

const botId = async (handle: string) =>
  Number((await db()`SELECT id FROM bots WHERE handle = ${handle}`)[0]?.id);

describe("story harness wake reader", () => {
  beforeEach(async () => {
    await resetDb();
    seen.length = 0;
  });
  afterEach(() => {
    seen.length = 0;
  });

  it("makes a wake URL, so the site sees the bot as woken by it", async () => {
    const b = await register("reader-bot");
    expect(await wokenBy(db(), await botId(b.handle))).toBe("none");
    const r = await wakeReader(BASE, b.key, api, get);
    expect(r.via).toBe("wake_url");
    expect(r.error).toBeUndefined();
    expect(await wokenBy(db(), await botId(b.handle))).toBe("wake_url");
  });

  it("reads the same number the key reads, and sees it rise", async () => {
    const b = await register("reader-two");
    const other = await register("reader-sender");
    const r = await wakeReader(BASE, b.key, api, get);
    const byKey = async () =>
      Number((await call(wakeRoute, { key: b.key })).body.wake);
    const before = await r.read();
    expect(before).toBe(await byKey());
    // A pairing would be the story's way in; an open inbox and a sender past
    // its first days are enough here.
    await db()`UPDATE bots SET created_at = now() - interval '3 days' WHERE handle = ${other.handle}`;
    const { POST: inbox } = await import("@/app/v1/me/inbox/route");
    for (const x of [b, other])
      await call(inbox, { key: x.key, body: { open: true } });
    const sent = await call(sendRoute, {
      key: other.key,
      body: { to: b.handle, body: "hello" },
    });
    expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);
    const after = await r.read();
    expect(after).toBeGreaterThan(before);
    expect(after).toBe(await byKey());
  });

  it("reads the URL at the trial's own base, never the host the site named", async () => {
    const b = await register("reader-three");
    const r = await wakeReader(BASE, b.key, api, get);
    await r.read();
    expect(seen.length).toBe(1);
    expect(seen[0]?.startsWith(`${BASE}/v1/wake/`)).toBe(true);
  });

  it("falls back to the key when the site won't make a URL", async () => {
    const b = await register("reader-four");
    const refusing = async (method: string, p: string, key?: string) =>
      p === "/v1/me/wake/url"
        ? { status: 403, json: { error: { code: "not_yet" } } }
        : api(method, p, key);
    const r = await wakeReader(BASE, b.key, refusing, get);
    expect(r.via).toBe("key");
    expect(r.error).toContain("403");
    expect(Number.isFinite(await r.read())).toBe(true);
    expect(seen.length).toBe(0);
    expect(await wokenBy(db(), await botId(b.handle))).toBe("none");
  });

  it("falls back to the key when making a URL throws", async () => {
    const b = await register("reader-five");
    const throwing = async (method: string, p: string, key?: string) => {
      if (p === "/v1/me/wake/url") throw new Error("network down");
      return api(method, p, key);
    };
    const r = await wakeReader(BASE, b.key, throwing, get);
    expect(r.via).toBe("key");
    expect(r.error).toContain("network down");
  });

  it("reads NaN, not a stale number, when the URL stops working", async () => {
    const b = await register("reader-six");
    const r = await wakeReader(BASE, b.key, api, get);
    expect(Number.isFinite(await r.read())).toBe(true);
    // A second URL replaces the first, as a real app's remake would.
    await call(wakeUrlRoute, { key: b.key });
    expect(Number.isNaN(await r.read())).toBe(true);
  });
});
