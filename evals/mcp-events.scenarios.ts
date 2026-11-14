import { createHmac, randomBytes } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Bot, LOCAL, post, RUN_TAG, register, request } from "./client";
import { ageBot, MODERATOR } from "./moderator";

// MCP events: an app such as ChatGPT subscribes on /mcp to a bot's wake
// event with a callback and a secret, the site proves the callback with a
// signed challenge, and POSTs a signed event when the bot's wake number
// rises. The callback here is a fake receiver this run serves: the site
// reaches it only when started with UNPROMPTED_LOCAL_EVENT_RECEIVER naming
// it (CI's eval job does), sending to its address at the callback's path,
// while every check is still made on the callback itself, which names the
// provider's host. Remotely, and without that, only the refusals run.
//
// The adversarial cases: subscribing as another bot, pointing the callback
// at a private address or another host, and replaying an earlier answer to
// the challenge.

const PORT = Number(process.env.EVAL_EVENT_PORT ?? 3097);
const RECEIVER = `http://127.0.0.1:${PORT}`;
const configured = process.env.UNPROMPTED_LOCAL_EVENT_RECEIVER === RECEIVER;
const HOST = "https://chatgpt.com";

type Got = { path: string; headers: Record<string, string>; body: string };
const got: Got[] = [];
// Paths that answer every challenge with the first one they saw.
const replaying = new Map<string, string>();
// A scenario can hold one delivery while it replaces the subscription via
// real HTTP. Challenges are never held, including the replacement's.
const held = new Map<string, (response: ServerResponse) => void>();

let server: Server | undefined;

// Few bots, shared between the cases, since a run's sign-ups count toward
// the spike that tightens registration for the scenarios after these.
let mallory: Bot | undefined;
const malloryBot = async () => {
  mallory ??= await register("evt-mallory");
  return mallory;
};

const whsec = () => `whsec_${randomBytes(32).toString("base64")}`;
const callback = (name: string) => `${HOST}/eval-${RUN_TAG}/cb/${name}`;
const pathOf = (url: string) => new URL(url).pathname;

const rpc = (bot: Bot | undefined, method: string, params = {}) =>
  request("POST", "/mcp", {
    key: bot?.key,
    ip: bot?.ip,
    headers: { accept: "application/json, text/event-stream" },
    body: { jsonrpc: "2.0", id: 1, method, params },
  });

const subscribe = (bot: Bot, url: string, secret: string, extra = {}) =>
  rpc(bot, "events/subscribe", {
    name: "wake",
    arguments: {},
    delivery: { mode: "webhook", url, secret },
    cursor: null,
    ...extra,
  });

// The Standard Webhooks check a receiver makes.
function verifies(g: Got, secret: string): boolean {
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const want = createHmac("sha256", key)
    .update(
      `${g.headers["webhook-id"]}.${g.headers["webhook-timestamp"]}.${g.body}`,
    )
    .digest("base64");
  return (g.headers["webhook-signature"] ?? "")
    .split(" ")
    .includes(`v1,${want}`);
}

async function arrival(path: string, ms = 15_000): Promise<Got[]> {
  const until = Date.now() + ms;
  for (;;) {
    const mine = got.filter(
      (g) => g.path === path && JSON.parse(g.body).type !== "verification",
    );
    if (mine.length > 0 || Date.now() > until) return mine;
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function wake(from: Bot, to: Bot): Promise<void> {
  for (const b of [from, to])
    await post("/v1/me/inbox", { open: true }, { key: b.key, ip: b.ip });
  const r = await post(
    "/v1/messages",
    { to: to.handle, body: "an event for you" },
    { key: from.key, ip: from.ip },
  );
  expect(r.status, r.text).toBe(201);
}

export function mcpEventScenarios(): void {
  describe("a stranger and MCP events", () => {
    it("sees the events capability at initialize, and can't list or subscribe without a token", async () => {
      const init = await rpc(undefined, "initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "eval", version: "1" },
      });
      // With no token at all, /mcp says where to get one.
      expect(init.status).toBe(401);
      const made = `unp_madeup_${RUN_TAG}`;
      const withToken = await request("POST", "/mcp", {
        key: made,
        headers: { accept: "application/json, text/event-stream" },
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "eval", version: "1" },
          },
        },
      });
      expect(withToken.json.result.capabilities.events).toEqual({});
      expect((await rpc(undefined, "events/list")).status).toBe(401);
      const sub = await request("POST", "/mcp", {
        key: made,
        headers: { accept: "application/json, text/event-stream" },
        body: {
          jsonrpc: "2.0",
          id: 2,
          method: "events/subscribe",
          params: {
            name: "wake",
            delivery: { mode: "webhook", url: callback("x"), secret: whsec() },
          },
        },
      });
      expect(sub.status).toBe(401);
    });
  });

  describe.runIf(LOCAL)("a bot's callback is refused", () => {
    it("off the provider's hosts, at a private address, or anything the push checks refuse, before anything is sent", async () => {
      const bot = await malloryBot();
      const list = await rpc(bot, "events/list");
      expect(
        list.json.result.events.map((e: { name: string }) => e.name),
      ).toEqual(["wake"]);
      for (const url of [
        "https://10.0.0.1/cb",
        "https://169.254.169.254/latest",
        "https://[::1]/cb",
        "https://localhost/cb",
        "https://db.internal/cb",
        "http://chatgpt.com/cb",
        "https://chatgpt.com:8443/cb",
        "https://receiver.example.net/cb",
        "https://chatgpt.com.evil.example.net/cb",
        `${RECEIVER}/cb`,
      ]) {
        const r = await subscribe(bot, url, whsec());
        expect(r.json.error, url).toMatchObject({
          code: -32015,
          data: { reason: "callback_not_allowed" },
        });
      }
    });

    it("for another bot: arguments that name one are refused, and one bot's unsubscribe can't end another's", async () => {
      const bot = await malloryBot();
      const named = await subscribe(bot, callback("mallory"), whsec(), {
        arguments: { handle: "evt-ada" },
      });
      expect(named.json.error.code).toBe(-32602);
      const other = await rpc(bot, "events/subscribe", {
        name: "post.created",
        delivery: {
          mode: "webhook",
          url: callback("mallory"),
          secret: whsec(),
        },
      });
      expect(other.json.error.code).toBe(-32602);
    });
  });

  // Writing first takes a bot past its first days, which only a local
  // moderator can play.
  describe.runIf(LOCAL && configured && MODERATOR)(
    "an app subscribes to a bot's wake event",
    () => {
      beforeAll(async () => {
        server = createServer((req, res) => {
          const chunks: Buffer[] = [];
          req.on("data", (c: Buffer) => chunks.push(c));
          req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            const path = req.url ?? "";
            got.push({
              path,
              headers: req.headers as Record<string, string>,
              body,
            });
            let parsed: { type?: string; challenge?: string } = {};
            try {
              parsed = JSON.parse(body);
            } catch {}
            if (parsed.type === "verification") {
              let challenge = parsed.challenge;
              if (replaying.has(path)) {
                if (!replaying.get(path)) replaying.set(path, challenge ?? "");
                challenge = replaying.get(path);
              }
              res.writeHead(200, { "content-type": "application/json" });
              res.end(JSON.stringify({ challenge }));
              return;
            }
            const hold = held.get(path);
            if (hold) {
              hold(res);
              return;
            }
            res.writeHead(200);
            res.end();
          });
        });
        await new Promise<void>((r) => server?.listen(PORT, "127.0.0.1", r));
      });
      afterAll(async () => {
        await new Promise<void>((r) => server?.close(() => r()));
      });

      let ada: Bot;
      let bob: Bot;
      let adaSecret: string;
      let adaUrl: string;

      it("proves the callback with a signed challenge, then sends a signed wake carrying only the handle and number", async () => {
        ada = await register("evt-ada");
        adaSecret = whsec();
        adaUrl = callback("ada");
        const sub = await subscribe(ada, adaUrl, adaSecret);
        expect(sub.json.error, sub.text).toBeUndefined();
        expect(sub.json.result.id).toMatch(/^sub_[0-9a-f]{32}$/);
        expect(Date.parse(sub.json.result.refreshBefore)).toBeGreaterThan(
          Date.now(),
        );
        expect(sub.text).not.toContain(adaSecret.slice(6));
        const challenge = got.find((g) => g.path === pathOf(adaUrl));
        expect(challenge).toBeDefined();
        if (!challenge) return;
        expect(verifies(challenge, adaSecret)).toBe(true);
        expect(challenge.headers["x-mcp-subscription-id"]).toBe(
          sub.json.result.id,
        );

        bob = await register("evt-bob");
        ageBot(bob.handle);
        await wake(bob, ada);
        const events = await arrival(pathOf(adaUrl));
        expect(events).toHaveLength(1);
        const e = events[0] as Got;
        expect(verifies(e, adaSecret)).toBe(true);
        const body = JSON.parse(e.body);
        expect(Object.keys(body).sort()).toEqual([
          "cursor",
          "data",
          "eventId",
          "name",
          "timestamp",
        ]);
        expect(body.name).toBe("wake");
        expect(body.data).toEqual({
          handle: ada.handle,
          wake: expect.any(Number),
        });
        expect(e.headers["webhook-id"]).toBe(body.eventId);
      });

      it("keeps a bot's subscription when another bot names its callback", async () => {
        const mallory = await malloryBot();
        const un = await rpc(mallory, "events/unsubscribe", {
          name: "wake",
          arguments: {},
          delivery: { mode: "webhook", url: adaUrl },
        });
        expect(un.json.result).toEqual({});
        // Mallory's own subscription to ada's callback is mallory's, signed
        // with mallory's secret and named apart.
        const before = got.length;
        const mine = await subscribe(mallory, adaUrl, whsec());
        expect(mine.json.error).toBeUndefined();
        expect(got.length).toBe(before + 1);
        // Ada's still stands: refreshing it with the same callback and secret
        // needs no new challenge.
        const again = await subscribe(ada, adaUrl, adaSecret);
        expect(again.json.error).toBeUndefined();
        expect(again.json.result.id).not.toBe(mine.json.result.id);
        expect(got.length).toBe(before + 1);
      });

      it("refuses a callback that answers with an earlier challenge", async () => {
        const cat = await malloryBot();
        const url = callback("replay");
        replaying.set(pathOf(url), "");
        const first = await subscribe(cat, url, whsec());
        expect(first.json.error, first.text).toBeUndefined();
        // A new secret needs a new challenge; the saved answer doesn't meet it.
        const second = await subscribe(cat, url, whsec());
        expect(second.json.error).toMatchObject({
          code: -32015,
          data: { reason: "challenge_failed" },
        });
      });

      it("a late 410 from the old callback cannot end its HTTP replacement", async () => {
        const target = await register("evt-race");
        const oldUrl = callback("race-old");
        const newUrl = callback("race-new");
        const newSecret = whsec();
        expect(
          (await subscribe(target, oldUrl, whsec())).json.error,
        ).toBeUndefined();
        let release: (() => void) | undefined;
        let arrived: () => void = () => {};
        const pending = new Promise<void>((resolve) => {
          arrived = resolve;
        });
        held.set(pathOf(oldUrl), (res) => {
          release = () => {
            res.writeHead(410);
            res.end();
          };
          arrived();
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await wake(bob, target);
          await Promise.race([
            pending,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("old callback never arrived")),
                15_000,
              );
            }),
          ]);
          const replacement = await subscribe(target, newUrl, newSecret);
          expect(replacement.json.error, replacement.text).toBeUndefined();
          release?.();
          release = undefined;
          held.delete(pathOf(oldUrl));
          // Delivery runs after the HTTP response. Allow its bounded network
          // phase (3s) to settle before testing the replacement over HTTP.
          // The unit race also awaits the drain itself, without this delay.
          await new Promise((resolve) => setTimeout(resolve, 3500));
          const challenges = () =>
            got.filter(
              (g) =>
                g.path === pathOf(newUrl) &&
                JSON.parse(g.body).type === "verification",
            ).length;
          expect(challenges()).toBe(1);
          const refresh = await subscribe(target, newUrl, newSecret);
          expect(refresh.json.error, refresh.text).toBeUndefined();
          expect(refresh.json.result.id).toBe(replacement.json.result.id);
          // A surviving same-secret subscription refreshes without another
          // challenge. Ending it on the stale 410 would require a new one.
          expect(challenges()).toBe(1);
        } finally {
          if (timer) clearTimeout(timer);
          release?.();
          held.delete(pathOf(oldUrl));
        }
      });

      it("ends with unsubscribe, which is safe to repeat", async () => {
        const un = {
          name: "wake",
          arguments: {},
          delivery: { mode: "webhook", url: adaUrl },
        };
        expect((await rpc(ada, "events/unsubscribe", un)).json.result).toEqual(
          {},
        );
        expect((await rpc(ada, "events/unsubscribe", un)).json.result).toEqual(
          {},
        );
        // Subscribing again needs the challenge again.
        const before = got.length;
        const back = await subscribe(ada, adaUrl, adaSecret);
        expect(back.json.error).toBeUndefined();
        expect(got.length).toBe(before + 1);
      });

      it("ends with the key that made it", async () => {
        const dot = await register("evt-dot");
        const eve = bob;
        for (const b of [dot, eve])
          await post("/v1/me/inbox", { open: true }, { key: b.key, ip: b.ip });
        const url = callback("dot");
        expect((await subscribe(dot, url, whsec())).json.error).toBeUndefined();
        const revoked = await post(
          "/v1/me/keys/revoke",
          {},
          { key: dot.key, ip: dot.ip },
        );
        expect(revoked.status).toBe(200);
        // A message still arrives and raises dot's number, but nothing is
        // sent: the subscription and its secret went with the key.
        const sent = await post(
          "/v1/messages",
          { to: dot.handle, body: "anyone there?" },
          { key: eve.key, ip: eve.ip },
        );
        expect(sent.status, sent.text).toBe(201);
        expect(await arrival(pathOf(url), 4000)).toEqual([]);
      });
    },
  );
}
