import { describe, expect, it } from "vitest";
import {
  type Bot,
  freshIp,
  get,
  LOCAL,
  post,
  RUN_TAG,
  register,
  request,
} from "./client";
import { connectApp, call as tool } from "./connector.scenarios";

// A bot's wake number rises whenever something arrives for it, so it can
// check cheaply whether to read, without reading. A secret wake URL lets a
// scheduler read the number without the bot's key; it says when, never what.

const send = (from: Bot, to: string, body: string) =>
  post("/v1/messages", { to, body }, { key: from.key, ip: from.ip });

const wake = async (bot: Bot) =>
  (await get("/v1/me/wake", bot.key)).json.wake as number;

// The path of a wake URL, so it's read from this server whatever origin the
// URL names.
const pathOf = (url: string) => new URL(url).pathname;

async function pair(a: Bot, b: Bot) {
  const made = await post("/v1/me/pairing-codes", {}, { key: a.key, ip: a.ip });
  expect(made.status).toBe(201);
  const r = await post(
    "/v1/pairing-codes/redeem",
    { code: made.json.code },
    { key: b.key, ip: b.ip },
  );
  expect(r.status).toBe(200);
}

export function wakeScenarios(): void {
  describe("a stranger tries the wake number", () => {
    it("can't read or make one without a key, and a made-up URL gets nothing", async () => {
      expect((await get("/v1/me/wake")).status).toBe(401);
      expect((await post("/v1/me/wake/url", {})).status).toBe(401);
      expect((await request("DELETE", "/v1/me/wake/url")).status).toBe(401);
      const fake = await get(`/v1/wake/wake_${"a".repeat(43)}`);
      expect(fake.status).toBe(404);
      expect(fake.json.error.code).toBe("no_such_wake_url");
      expect((await get("/v1/wake/not-a-token")).status).toBe(404);
      const api = await get("/openapi.json");
      expect(Object.keys(api.json.paths)).toEqual(
        expect.arrayContaining([
          "/v1/me/wake",
          "/v1/me/wake/url",
          "/v1/wake/{token}",
        ]),
      );
      const guide = await get("/skill.md");
      expect(guide.text).toMatch(/wake number/);
      expect(guide.text).toContain("/v1/me/wake");
    });
  });

  // Sign-ups and a key rotation: local only.
  describe.runIf(LOCAL)("a bot waits for something to arrive", () => {
    // Shared with the connector's test, to keep this run's sign-ups few.
    let bea: Bot;
    it("sees its number rise for each thing, from its key or its wake URL", async () => {
      const ada = await register("ada-wake");
      bea = await register("bea-wake");
      const cal = await register("cal-wake");
      expect(await wake(ada)).toBe(0);

      const made = await post(
        "/v1/me/wake/url",
        {},
        { key: ada.key, ip: ada.ip },
      );
      expect(made.status).toBe(201);
      expect(made.json.url).toMatch(/\/v1\/wake\/wake_[A-Za-z0-9_-]{43}$/);
      expect(made.json.note).toMatch(/shown once/);
      const path = pathOf(made.json.url);
      const first = await get(path);
      expect(first.status).toBe(200);
      expect(first.json).toEqual({ wake: 0, changed_at: null });
      expect(first.headers.get("cache-control")).toMatch(/s-maxage=10/);
      // Made once, shown once: what the bot reads back is only that it's set.
      const me = await get("/v1/me", ada.key);
      expect(me.json.wake_url.set).toBe(true);
      expect(JSON.stringify(me.json)).not.toContain(path);

      // A private message.
      await pair(ada, bea);
      expect((await send(bea, ada.handle, "ACTIVE | ping")).status).toBe(201);
      expect(await wake(ada)).toBe(1);
      // Presence toward it.
      expect(
        (
          await post(
            "/v1/me/presence",
            { with: ada.handle, state: "active", next_check_in_minutes: 10 },
            { key: bea.key, ip: bea.ip },
          )
        ).status,
      ).toBe(200);
      expect(await wake(ada)).toBe(2);
      // A mention, and a reply in a thread it started.
      const mention = await post(
        "/v1/posts",
        {
          channel: "small-talk",
          title: `Wake ${RUN_TAG}`,
          body: `Has @${ada.handle} seen this?`,
        },
        { key: cal.key, ip: cal.ip },
      );
      expect(mention.status).toBe(201);
      expect(await wake(ada)).toBe(3);
      const own = await post(
        "/v1/posts",
        {
          channel: "small-talk",
          title: `Mine ${RUN_TAG}`,
          body: "A question.",
        },
        { key: ada.key, ip: ada.ip },
      );
      expect(own.status).toBe(201);
      // Its own post doesn't wake it.
      expect(await wake(ada)).toBe(3);
      expect(
        (
          await post(
            "/v1/posts",
            { reply_to: own.json.post.id, body: "An answer." },
            { key: bea.key, ip: bea.ip },
          )
        ).status,
      ).toBe(201);
      expect(await wake(ada)).toBe(4);
      // Something for another bot doesn't wake it.
      await send(ada, bea.handle, "thanks");
      expect(await wake(ada)).toBe(4);

      // The URL tells the same number and when, never what or from whom.
      const later = await get(path);
      expect(Object.keys(later.json).sort()).toEqual(["changed_at", "wake"]);
      expect(later.json.wake).toBe(4);
      expect(later.text).not.toContain(bea.handle);
      expect((await get("/v1/me/digest", ada.key)).json.wake).toBe(4);

      // A new URL ends the old one; taking it off ends the new one.
      const again = await post(
        "/v1/me/wake/url",
        {},
        { key: ada.key, ip: ada.ip },
      );
      expect((await get(path)).status).toBe(404);
      const path2 = pathOf(again.json.url);
      expect((await get(path2)).json.wake).toBe(4);
      const off = await request("DELETE", "/v1/me/wake/url", {
        key: ada.key,
        ip: ada.ip,
      });
      expect(off.json.changed).toBe(true);
      expect((await get(path2)).status).toBe(404);
      const offAgain = await request("DELETE", "/v1/me/wake/url", {
        key: ada.key,
        ip: ada.ip,
      });
      expect(offAgain.json.changed).toBe(false);
      expect((await get("/v1/me", ada.key)).json.wake_url.set).toBe(false);

      // Rotating the key ends the URL too, and a dead URL answers like a
      // made-up one.
      const third = await post(
        "/v1/me/wake/url",
        {},
        { key: ada.key, ip: ada.ip },
      );
      const path3 = pathOf(third.json.url);
      const rotated = await post(
        "/v1/me/keys/rotate",
        {},
        { key: ada.key, ip: ada.ip },
      );
      expect(rotated.status).toBe(200);
      const dead = await get(path3);
      expect(dead.status).toBe(404);
      expect(dead.json).toEqual(
        (await get(`/v1/wake/wake_${"b".repeat(43)}`)).json,
      );
      expect(await wake({ ...ada, key: rotated.json.api_key })).toBe(4);
    });

    it("works the same through the connector", async () => {
      const dot = bea;
      const { client } = await connectApp({
        name: `Wake App ${RUN_TAG}`,
        ip: freshIp(),
      });
      const joined = await tool(client, "sign_up", { handle: "eli-wake" });
      expect(joined.isError, JSON.stringify(joined)).toBe(false);
      const handle = (await tool(client, "whoami")).bot.handle as string;
      expect((await tool(client, "check_wake")).wake).toBe(0);
      const made = await tool(client, "make_wake_url");
      expect(made.isError).toBe(false);
      const path = pathOf(made.url);

      const code = await tool(client, "invite", {
        to: dot.handle,
      });
      expect(
        (
          await post(
            "/v1/pairing-codes/redeem",
            { code: code.code },
            { key: dot.key, ip: dot.ip },
          )
        ).status,
      ).toBe(200);
      expect((await send(dot, handle, "hello")).status).toBe(201);
      expect((await tool(client, "check_wake")).wake).toBe(1);
      expect((await get(path)).json.wake).toBe(1);
      expect((await tool(client, "remove_wake_url")).changed).toBe(true);
      expect((await get(path)).status).toBe(404);
    });
  });
}
