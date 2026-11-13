import { createHmac, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { POST as inboxRoute } from "@/app/v1/me/inbox/route";
import { POST as revokeRoute } from "@/app/v1/me/keys/revoke/route";
import { POST as rotateRoute } from "@/app/v1/me/keys/rotate/route";
import { POST as pushRoute } from "@/app/v1/me/push/route";
import { POST as sendRoute } from "@/app/v1/messages/route";
import { setFrozen } from "@/lib/admin";
import { db } from "@/lib/db";
import {
  EVENT_TTL_DEFAULT_MS,
  EVENT_TTL_MAX_MS,
  EVENT_TTL_MIN_MS,
} from "@/lib/event-subscriptions";
import { lookupBot } from "@/lib/lookup";
import { EVENT_METHODS } from "@/lib/mcp";
import {
  type Deliver,
  type Delivery,
  drainForAWhile,
  drainPushes,
  PUSH_MAX_FAILURES,
  sweepAdapters,
  useDeliver,
} from "@/lib/push";
import { ANTI_ABUSE_DEFAULTS } from "@/lib/settings";
import { checkRegistration } from "@/lib/wake-adapters";
import {
  callbackHostAllowed,
  mcpEventsAdapter,
  secretBytes,
  signEvent,
  subscriptionId,
} from "@/lib/wake-adapters/mcp-events";
import { openSecret, sealSecret } from "@/lib/wake-secrets";
import { wokenBy } from "@/lib/woken";
import { call, freshIp, register, resetDb } from "./helpers";

// MCP events, end to end: an app subscribes on /mcp with the bot's own
// connection, the site proves the callback with a signed challenge, keeps
// the secret sealed, and POSTs a signed wake event when the bot's wake
// number rises, at most once a gap, falling through to the push URL when it
// fails. Every refusal too.

const CALLBACK = "https://chatgpt.com/backend-api/events/cb_1";
const PUSH = "https://hooks.example.org/in";
const whsec = (n = 32) => `whsec_${randomBytes(n).toString("base64")}`;

type Sent = {
  url: string;
  body: string;
  headers: Record<string, string>;
  read: number;
};
let sent: Sent[] = [];
// How the fake callback answers: echo the challenge, by default.
let answer: (s: Sent) => Delivery | Promise<Delivery>;
const echo = (s: Sent): Delivery => {
  const b = JSON.parse(s.body);
  return b.type === "verification"
    ? { status: 200, body: JSON.stringify({ challenge: b.challenge }) }
    : { status: 200 };
};

const deliver: Deliver = async (url, body, headers, opts) => {
  const s = { url, body, headers, read: opts?.readBody ?? 0 };
  sent.push(s);
  return answer(s);
};

beforeEach(async () => {
  await resetDb();
  sent = [];
  answer = echo;
  useDeliver(deliver);
});
afterEach(() => {
  delete process.env.UNPROMPTED_READ_ONLY;
  useDeliver(null);
});

let rpcId = 0;
async function rpc(
  token: string | undefined,
  method: string,
  params: Record<string, unknown> = {},
) {
  rpcId += 1;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "x-real-ip": freshIp(),
    host: "unprompted.test",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await mcpRoute(
    new Request("http://unprompted.test/v1/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params }),
    }),
    undefined as never,
  );
  const text = await res.text();
  // biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary JSON
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: res.status, body };
}

const subParams = (url = CALLBACK, secret = whsec(), extra = {}) => ({
  name: "wake",
  arguments: {},
  delivery: { mode: "webhook", url, secret },
  cursor: null,
  ...extra,
});

async function bot(handle: string) {
  const b = await register(handle);
  await db()`UPDATE bots SET created_at = now() - interval '3 days' WHERE handle = ${handle}`;
  const [r] = await db()<
    { id: string }[]
  >`SELECT id FROM bots WHERE handle = ${handle}`;
  await call(inboxRoute, { key: b.key, body: { open: true } });
  keys.set(b.handle, b.key);
  handles.set(b.key, b.handle);
  return { ...b, id: Number(r?.id) };
}

async function subscribed(handle = "alice", secret = whsec()) {
  const a = await bot(handle);
  const r = await rpc(a.key, "events/subscribe", subParams(CALLBACK, secret));
  expect(r.body.error, JSON.stringify(r.body)).toBeUndefined();
  sent = [];
  return { ...a, secret, sub: r.body.result };
}

// Each bot's key and handle, so a second message can follow a reply.
const keys = new Map<string, string>();
const handles = new Map<string, string>();

// A message, which raises the wake number of the bot it's to. A second one
// to a bot that hasn't answered waits for a reply, so it answers first
// (which raises only the sender's number).
async function message(from: { key: string }, to: string, body = "hello") {
  let r = await call(sendRoute, { key: from.key, body: { to, body } });
  if (r.status === 409 && r.body.error?.code === "waiting_for_reply") {
    const back = await call(sendRoute, {
      key: keys.get(to) ?? "",
      body: { to: handles.get(from.key) ?? "", body: "hi" },
    });
    expect(back.status, JSON.stringify(back.body)).toBe(201);
    r = await call(sendRoute, { key: from.key, body: { to, body } });
  }
  expect(r.status, JSON.stringify(r.body)).toBe(201);
}

// The Standard Webhooks check a receiver makes, written apart from the
// site's own signing.
function verifies(s: Sent, secret: string): boolean {
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const id = s.headers["webhook-id"];
  const t = s.headers["webhook-timestamp"];
  const want = createHmac("sha256", key)
    .update(`${id}.${t}.${s.body}`)
    .digest("base64");
  return (s.headers["webhook-signature"] ?? "")
    .split(" ")
    .some((sig) => sig === `v1,${want}`);
}

const count = async (table: string) => {
  const [r] = await db().unsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM ${table}`,
  );
  return r?.n ?? 0;
};

describe("events on /mcp", () => {
  it("advertises the events capability at initialize, without looking the token up", async () => {
    const r = await rpc("unp_made_up", "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(r.status).toBe(200);
    expect(r.body.result.capabilities).toMatchObject({ tools: {}, events: {} });
  });

  it("lists one event, wake, carrying only a handle and a number", async () => {
    const a = await bot("alice");
    const r = await rpc(a.key, "events/list");
    expect(r.body.result.events).toHaveLength(1);
    const e = r.body.result.events[0];
    expect(e.name).toBe("wake");
    expect(e.delivery).toEqual(["webhook"]);
    expect(e.inputSchema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect(Object.keys(e.payloadSchema.properties).sort()).toEqual([
      "handle",
      "wake",
    ]);
  });

  it("asks for a token, and a joined bot, before anything else", async () => {
    expect((await rpc(undefined, "events/list")).status).toBe(401);
    expect(
      (await rpc("unp_made_up", "events/subscribe", subParams())).status,
    ).toBe(401);
    expect(EVENT_METHODS).toEqual([
      "events/list",
      "events/subscribe",
      "events/unsubscribe",
    ]);
  });
});

describe("subscribing", () => {
  it("proves the callback with a signed challenge, then keeps the subscription", async () => {
    const a = await bot("alice");
    const secret = whsec();
    const r = await rpc(a.key, "events/subscribe", subParams(CALLBACK, secret));
    expect(r.body.error).toBeUndefined();
    const sub = r.body.result;
    expect(sub.id).toBe(subscriptionId(a.id, CALLBACK));
    expect(sub.cursor).toBeNull();
    expect(sub.truncated).toBe(false);
    const life = new Date(sub.refreshBefore).getTime() - Date.now();
    expect(Math.abs(life - EVENT_TTL_DEFAULT_MS)).toBeLessThan(60_000);
    expect(sent).toHaveLength(1);
    const c = sent[0] as Sent;
    expect(c.url).toBe(CALLBACK);
    expect(c.read).toBeGreaterThan(0);
    expect(JSON.parse(c.body)).toEqual({
      type: "verification",
      challenge: expect.any(String),
    });
    expect(c.headers["webhook-id"]).toMatch(/^msg_verification_/);
    expect(c.headers["x-mcp-subscription-id"]).toBe(sub.id);
    expect(verifies(c, secret)).toBe(true);
    expect(await wokenBy(db(), a.id)).toBe("event");
  });

  it("keeps the secret only sealed, and never shows or logs it", async () => {
    const secret = whsec(48);
    const a = await subscribed("alice", secret);
    const raw = Buffer.from(secret.slice(6), "base64");
    const [row] = await db()<
      {
        subscription_id: string;
        key_version: number;
        iv: Buffer;
        sealed: Buffer;
      }[]
    >`SELECT subscription_id, key_version, iv, sealed FROM event_secrets`;
    expect(row).toBeDefined();
    if (!row) return;
    expect(row.sealed.includes(raw)).toBe(false);
    expect(openSecret(a.id, Number(row.subscription_id), row)).toEqual(raw);
    // Bound to its bot and row: moved, it doesn't open.
    expect(openSecret(a.id + 1, Number(row.subscription_id), row)).toBeNull();
    expect(openSecret(a.id, Number(row.subscription_id) + 1, row)).toBeNull();
    const log = JSON.stringify(
      await db()`SELECT action, detail FROM action_log WHERE action LIKE 'event.%'`,
    );
    expect(log).toContain("chatgpt.com");
    expect(log).not.toContain(secret.slice(6));
    expect(log).not.toContain("backend-api");
    const subs = JSON.stringify(await db()`SELECT * FROM event_subscriptions`);
    expect(subs).not.toContain(secret.slice(6));
    expect(JSON.stringify(a.sub)).not.toContain(secret.slice(6));
  });

  it("refuses a callback that didn't echo the challenge, or one saved from before", async () => {
    const a = await bot("alice");
    let saved = "";
    answer = (s) => {
      const b = JSON.parse(s.body);
      saved ||= b.challenge;
      return { status: 200, body: JSON.stringify({ challenge: saved }) };
    };
    const first = await rpc(a.key, "events/subscribe", subParams());
    expect(first.body.error).toBeUndefined();
    // A second callback that replays the first challenge's answer.
    const other = "https://chatgpt.com/backend-api/events/cb_2";
    const r = await rpc(a.key, "events/subscribe", subParams(other));
    expect(r.body.error).toMatchObject({
      code: -32015,
      data: { reason: "challenge_failed" },
    });
    for (const bad of [
      { status: 200, body: "{}" },
      { status: 200, body: "not json" },
      { status: 500, body: "" },
      { status: 302 },
    ]) {
      answer = () => bad;
      const x = await rpc(a.key, "events/subscribe", subParams(other));
      expect(x.body.error?.data?.reason).toBe("challenge_failed");
    }
    answer = () => ({ status: null, error: "timeout" });
    const t = await rpc(a.key, "events/subscribe", subParams(other));
    expect(t.body.error?.data?.reason).toBe("timeout");
    // Only the first stands.
    expect(await count("event_subscriptions")).toBe(1);
  });

  it("refuses a callback off the provider's hosts, or anything the push checks refuse, before sending a thing", async () => {
    const a = await bot("alice");
    for (const url of [
      "https://receiver.example.net/hook",
      "https://chatgpt.com.evil.net/hook",
      "https://evilchatgpt.com/hook",
      "http://chatgpt.com/hook",
      "https://chatgpt.com:8443/hook",
      "https://10.0.0.1/hook",
      "https://[::1]/hook",
      "https://localhost/hook",
      "https://user:pw@chatgpt.com/hook",
    ]) {
      const r = await rpc(a.key, "events/subscribe", subParams(url));
      expect(r.body.error, url).toMatchObject({
        code: -32015,
        data: { reason: "callback_not_allowed" },
      });
    }
    expect(sent).toEqual([]);
    expect(await count("event_subscriptions")).toBe(0);
    expect(callbackHostAllowed("chatgpt.com")).toBe(true);
    expect(callbackHostAllowed("hooks.chatgpt.com")).toBe(true);
    expect(callbackHostAllowed("chatgpt.com.")).toBe(true);
    expect(callbackHostAllowed("notchatgpt.com")).toBe(false);
  });

  it("refuses a malformed event, arguments that name anything, or a bad secret", async () => {
    const a = await bot("alice");
    const cases: Record<string, unknown>[] = [
      { ...subParams(), name: "post.created" },
      { ...subParams(), arguments: { handle: "bob" } },
      { ...subParams(), arguments: [] },
      {
        ...subParams(),
        delivery: { mode: "poll", url: CALLBACK, secret: whsec() },
      },
      subParams(CALLBACK, "not-a-secret"),
      subParams(CALLBACK, whsec(16)),
      subParams(CALLBACK, whsec(65)),
      subParams(CALLBACK, whsec(), { ttlMs: -5 }),
    ];
    for (const p of cases) {
      const r = await rpc(a.key, "events/subscribe", p);
      expect(r.body.error?.code, JSON.stringify(p)).toBe(-32602);
    }
    expect(sent).toEqual([]);
    expect(secretBytes(whsec(24))).not.toBeNull();
    expect(secretBytes(whsec(64))).not.toBeNull();
  });

  it("holds the lifetime between its bounds", async () => {
    const a = await bot("alice");
    const life = async (ttlMs: unknown) => {
      const r = await rpc(
        a.key,
        "events/subscribe",
        subParams(CALLBACK, whsec(), { ttlMs }),
      );
      return new Date(r.body.result.refreshBefore).getTime() - Date.now();
    };
    expect(await life(1000)).toBeGreaterThan(EVENT_TTL_MIN_MS - 60_000);
    expect(await life(1000)).toBeLessThan(EVENT_TTL_MIN_MS + 60_000);
    expect(await life(null)).toBeGreaterThan(EVENT_TTL_MAX_MS - 60_000);
    expect(await life(1e12)).toBeLessThan(EVENT_TTL_MAX_MS + 60_000);
  });

  it("refreshes without a new challenge when nothing changed, and signs with both secrets for a while when the secret did", async () => {
    const a = await subscribed("alice");
    const again = await rpc(
      a.key,
      "events/subscribe",
      subParams(CALLBACK, a.secret),
    );
    expect(again.body.result.id).toBe(a.sub.id);
    expect(sent).toEqual([]);
    const fresh = whsec();
    const rotated = await rpc(
      a.key,
      "events/subscribe",
      subParams(CALLBACK, fresh),
    );
    expect(rotated.body.result.id).toBe(a.sub.id);
    expect(sent).toHaveLength(1);
    expect(verifies(sent[0] as Sent, fresh)).toBe(true);
    sent = [];
    const b = await bot("bob");
    await message(b, "alice");
    expect(await drainPushes()).toBe(1);
    const e = sent[0] as Sent;
    expect(e.headers["webhook-signature"]?.split(" ")).toHaveLength(2);
    expect(verifies(e, fresh)).toBe(true);
    expect(verifies(e, a.secret)).toBe(true);
    // Past the window, only the new one.
    await db()`UPDATE event_secrets SET retire_at = now() - interval '1 second' WHERE retire_at IS NOT NULL`;
    await db()`UPDATE event_sub_state SET last_sent_at = now() - interval '1 hour'`;
    await db()`UPDATE push_state SET last_sent_at = NULL`;
    sent = [];
    await message(b, "alice", "again");
    expect(await drainPushes()).toBe(1);
    expect(sent[0]?.headers["webhook-signature"]?.split(" ")).toHaveLength(1);
    expect(verifies(sent[0] as Sent, a.secret)).toBe(false);
  });

  it("counts a refresh against a limit of its own, not the push URL's", async () => {
    const a = await subscribed();
    let n = 0;
    for (;;) {
      const r = await rpc(
        a.key,
        "events/subscribe",
        subParams(CALLBACK, a.secret),
      );
      if (r.body.error) {
        expect(r.body.error).toMatchObject({
          code: -32000,
          data: { code: "rate_limited" },
        });
        break;
      }
      n += 1;
      expect(n).toBeLessThan(100);
    }
    // Past the push URL's 10 an hour, and nothing was sent.
    expect(n).toBeGreaterThan(10);
    expect(sent).toEqual([]);
    // The push URL's own limit is still there for a push URL.
    const set = await call(pushRoute, {
      key: a.key,
      path: "/v1/me/push",
      body: { url: PUSH },
    });
    expect(set.status).toBe(201);
  });

  it("counts every subscribe against the bot's hourly limit, before any challenge", async () => {
    const a = await bot("alice");
    let n = 0;
    for (;;) {
      const r = await rpc(
        a.key,
        "events/subscribe",
        subParams(CALLBACK, whsec()),
      );
      if (r.body.error) {
        expect(r.body.error).toMatchObject({
          code: -32000,
          data: { code: "rate_limited" },
        });
        break;
      }
      n += 1;
      expect(n).toBeLessThan(50);
    }
    const before = sent.length;
    await rpc(a.key, "events/subscribe", subParams(CALLBACK, whsec()));
    expect(sent.length).toBe(before);
  });
});

describe("waking", () => {
  it("sends a signed wake event carrying only the handle and the new number", async () => {
    const a = await subscribed();
    const b = await bot("bob");
    await message(b, "alice");
    expect(await drainPushes()).toBe(1);
    expect(sent).toHaveLength(1);
    const e = sent[0] as Sent;
    expect(e.url).toBe(CALLBACK);
    expect(e.read).toBe(0);
    const body = JSON.parse(e.body);
    expect(Object.keys(body).sort()).toEqual([
      "cursor",
      "data",
      "eventId",
      "name",
      "timestamp",
    ]);
    expect(body).toMatchObject({
      name: "wake",
      data: { handle: "alice", wake: 1 },
      cursor: null,
    });
    expect(Object.keys(body.data).sort()).toEqual(["handle", "wake"]);
    expect(body.eventId).toMatch(/^evt_[0-9a-f]{32}$/);
    expect(e.headers["webhook-id"]).toBe(body.eventId);
    expect(e.headers["x-mcp-subscription-id"]).toBe(a.sub.id);
    expect(e.headers["content-type"]).toBe("application/json");
    expect(Number(e.headers["webhook-timestamp"])).toBeCloseTo(
      Date.now() / 1000,
      -1,
    );
    expect(verifies(e, a.secret)).toBe(true);
    expect(signEvent([], "x", 1, "")).toBe("");
  });

  it("queues a wake for a bot whose only method is an event subscription", async () => {
    const a = await subscribed();
    const b = await bot("bob");
    await message(b, "alice");
    const [s] = await db()<{ pending_since: Date | null }[]>`
      SELECT pending_since FROM push_state WHERE bot_id = ${a.id}`;
    expect(s?.pending_since).not.toBeNull();
  });

  it("waits out its gap of minutes, then sends the arrivals in between as one", async () => {
    const a = await subscribed();
    const b = await bot("bob");
    await message(b, "alice");
    expect(await drainPushes()).toBe(1);
    sent = [];
    // The push gap of seconds is past; the event's gap of minutes isn't.
    await message(b, "alice", "two");
    await message(b, "alice", "three");
    await db()`UPDATE push_state SET last_sent_at = now() - interval '1 minute'`;
    expect(await drainPushes()).toBe(0);
    expect(sent).toEqual([]);
    const [s] = await db()<{ pending_since: Date; last_sent_at: Date }[]>`
      SELECT p.pending_since, e.last_sent_at
      FROM push_state p JOIN event_sub_state e USING (bot_id)
      WHERE bot_id = ${a.id}`;
    expect(
      s ? (s.pending_since.getTime() - s.last_sent_at.getTime()) / 1000 : 0,
    ).toBeCloseTo(ANTI_ABUSE_DEFAULTS.mcp_event_gap_seconds, 0);
    // Due now: one event, with the newest number.
    await db()`UPDATE event_sub_state SET last_sent_at = now() - interval '1 hour'`;
    await db()`UPDATE push_state SET pending_since = now()`;
    expect(await drainPushes()).toBe(1);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]?.body ?? "{}").data).toEqual({
      handle: "alice",
      wake: 3,
    });
  });

  it("takes its gap from the private anti-abuse numbers", async () => {
    await db()`
      INSERT INTO settings (key, value)
      VALUES ('anti_abuse_limits', ${db().json({ mcp_event_gap_seconds: 600 })})`;
    const a = await subscribed();
    const b = await bot("bob");
    await message(b, "alice");
    await drainPushes();
    await message(b, "alice", "two");
    await db()`UPDATE push_state SET last_sent_at = now() - interval '1 minute'`;
    await drainPushes();
    const [s] = await db()<{ wait: number }[]>`
      SELECT extract(epoch FROM p.pending_since - e.last_sent_at)::int AS wait
      FROM push_state p JOIN event_sub_state e USING (bot_id)
      WHERE bot_id = ${a.id}`;
    expect(s?.wait).toBe(600);
  });

  it("counts against a site-wide cap of its own, not the per-host one", async () => {
    await db()`
      INSERT INTO settings (key, value)
      VALUES ('anti_abuse_limits', ${db().json({ mcp_event_global: 1 })})`;
    // The one allowed this hour goes to alice's challenge.
    await subscribed("alice");
    const r = await rpc(
      (await bot("carol")).key,
      "events/subscribe",
      subParams(),
    );
    expect(r.body.error?.data?.code).toBe("rate_limited");
    const b = await bot("bob");
    await message(b, "alice");
    expect(await drainPushes()).toBe(0);
    expect(sent).toEqual([]);
    const [s] = await db()<{ pending_since: Date | null }[]>`
      SELECT pending_since FROM push_state WHERE bot_id = (SELECT id FROM bots WHERE handle = 'alice')`;
    expect(s?.pending_since?.getTime()).toBeGreaterThan(Date.now());
  });

  it("falls through to the push URL when the event fails, and counts the failure", async () => {
    const a = await subscribed();
    const set = await call(pushRoute, {
      key: a.key,
      path: "/v1/me/push",
      body: { url: PUSH },
    });
    expect(set.status).toBe(201);
    answer = (s) => (s.url === CALLBACK ? { status: 500 } : { status: 200 });
    const b = await bot("bob");
    await message(b, "alice");
    expect(await drainPushes()).toBe(1);
    expect(sent.map((s) => s.url)).toEqual([CALLBACK, PUSH]);
    const [st] = await db()<{ failures: number; last_status: number }[]>`
      SELECT failures, last_status FROM event_sub_state`;
    expect(st).toEqual({ failures: 1, last_status: 500 });
  });

  it("isn't followed by the push URL when the event delivers", async () => {
    const a = await subscribed();
    await call(pushRoute, {
      key: a.key,
      path: "/v1/me/push",
      body: { url: PUSH },
    });
    const b = await bot("bob");
    await message(b, "alice");
    expect(await drainPushes()).toBe(1);
    expect(sent.map((s) => s.url)).toEqual([CALLBACK]);
  });

  it("ends the subscription on a 410, and goes on to the push URL", async () => {
    const a = await subscribed();
    await call(pushRoute, {
      key: a.key,
      path: "/v1/me/push",
      body: { url: PUSH },
    });
    answer = (s) => (s.url === CALLBACK ? { status: 410 } : { status: 200 });
    const b = await bot("bob");
    await message(b, "alice");
    expect(await drainPushes()).toBe(1);
    expect(sent.map((s) => s.url)).toEqual([CALLBACK, PUSH]);
    expect(await count("event_secrets")).toBe(0);
    const [end] = await db()<{ ended: string }[]>`
      SELECT ended FROM event_subscriptions ORDER BY id DESC LIMIT 1`;
    expect(end?.ended).toBe("gone");
    expect(await wokenBy(db(), a.id)).toBe("push");
  });

  it.each([
    410, 500, 200,
  ])("ignores an old callback's late %s after a replacement subscription", async (status) => {
    const a = await subscribed();
    const replacement = "https://chatgpt.com/backend-api/events/cb_2";
    let release: (d: Delivery) => void = () => {};
    let started: () => void = () => {};
    const arrived = new Promise<void>((resolve) => {
      started = resolve;
    });
    answer = (s) => {
      if (s.url === CALLBACK && JSON.parse(s.body).type !== "verification") {
        started();
        return new Promise<Delivery>((resolve) => {
          release = resolve;
        });
      }
      return echo(s);
    };
    const b = await bot("bob");
    await message(b, "alice");
    const draining = drainPushes();
    try {
      await arrived;
      const renewed = await rpc(
        a.key,
        "events/subscribe",
        subParams(replacement),
      );
      expect(renewed.body.error).toBeUndefined();
      // A stale success must not clear newer failures either.
      await db()`UPDATE event_sub_state SET failures = 2 WHERE bot_id = ${a.id}`;
      const before =
        await db()`SELECT * FROM event_sub_state WHERE bot_id = ${a.id}`;
      const secrets = await count("event_secrets");
      release({ status });
      expect(await draining).toBe(1);
      const [current] = await db()<
        { callback_url: string; ended: string | null }[]
      >`SELECT callback_url, ended FROM event_subscriptions
          WHERE bot_id = ${a.id} ORDER BY id DESC LIMIT 1`;
      expect(current).toEqual({ callback_url: replacement, ended: null });
      expect(await count("event_secrets")).toBe(secrets);
      expect(
        await db()`SELECT * FROM event_sub_state WHERE bot_id = ${a.id}`,
      ).toEqual(before);
      expect(await wokenBy(db(), a.id)).toBe("event");
      const [pending] = await db()<{ pending_since: Date | null }[]>`
          SELECT pending_since FROM push_state WHERE bot_id = ${a.id}`;
      expect(pending?.pending_since).toBeNull();
    } finally {
      release({ status });
      await draining;
    }
  });

  it("pauses after failures in a row, and a bot paused on both isn't claimed at all", async () => {
    const a = await subscribed();
    await db()`
      INSERT INTO event_sub_state (bot_id, failures) VALUES (${a.id}, ${PUSH_MAX_FAILURES})
      ON CONFLICT (bot_id) DO UPDATE SET failures = ${PUSH_MAX_FAILURES}`;
    expect(await wokenBy(db(), a.id)).toBe("none");
    const b = await bot("bob");
    await message(b, "alice");
    // Queued by the arrival, as any bot with a live method is, and then
    // left alone: not claimed and put off again every few seconds.
    const before = await db()<{ pending_since: Date | null }[]>`
      SELECT pending_since FROM push_state WHERE bot_id = ${a.id}`;
    expect(before[0]?.pending_since).not.toBeNull();
    expect(await drainPushes()).toBe(0);
    expect(sent).toEqual([]);
    const after = await db()<{ pending_since: Date | null }[]>`
      SELECT pending_since FROM push_state WHERE bot_id = ${a.id}`;
    expect(after).toEqual(before);
  });

  it("retries a failed event once its gap is over, until the pause", async () => {
    const a = await subscribed();
    answer = () => ({ status: 503 });
    const b = await bot("bob");
    await message(b, "alice");
    expect(await drainPushes()).toBe(1);
    // Queued again for when the gap ends, though nothing new arrived.
    const [q] = await db()<{ pending_since: Date; last_sent_at: Date }[]>`
      SELECT p.pending_since, e.last_sent_at
      FROM push_state p JOIN event_sub_state e USING (bot_id)
      WHERE bot_id = ${a.id}`;
    expect(
      q ? (q.pending_since.getTime() - q.last_sent_at.getTime()) / 1000 : 0,
    ).toBeCloseTo(ANTI_ABUSE_DEFAULTS.mcp_event_gap_seconds, 0);
    // When it's due, the same event goes again, and works.
    answer = echo;
    sent = [];
    await db()`UPDATE event_sub_state SET last_sent_at = now() - interval '1 hour'`;
    await db()`UPDATE push_state SET last_sent_at = NULL, pending_since = now()`;
    expect(await drainPushes()).toBe(1);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]?.body ?? "{}").data).toEqual({
      handle: "alice",
      wake: 1,
    });
    const [done] = await db()<
      { pending_since: Date | null; failures: number }[]
    >`
      SELECT p.pending_since, e.failures
      FROM push_state p JOIN event_sub_state e USING (bot_id)
      WHERE bot_id = ${a.id}`;
    expect(done).toEqual({ pending_since: null, failures: 0 });
    // The failure that reaches the pause queues nothing more.
    answer = () => ({ status: 500 });
    await db()`UPDATE event_sub_state SET failures = ${PUSH_MAX_FAILURES - 1}, last_sent_at = now() - interval '1 hour'`;
    await db()`UPDATE push_state SET last_sent_at = NULL, pending_since = now()`;
    expect(await drainPushes()).toBe(1);
    const [last] = await db()<
      { pending_since: Date | null; failures: number }[]
    >`
      SELECT p.pending_since, e.failures
      FROM push_state p JOIN event_sub_state e USING (bot_id)
      WHERE bot_id = ${a.id}`;
    expect(last).toEqual({ pending_since: null, failures: PUSH_MAX_FAILURES });
  });

  it("counts a 413 as a failure but doesn't retry it", async () => {
    const a = await subscribed();
    answer = () => ({ status: 413 });
    const b = await bot("bob");
    await message(b, "alice");
    expect(await drainPushes()).toBe(1);
    expect(sent).toHaveLength(1);
    const [st] = await db()<
      { pending_since: Date | null; failures: number; last_status: number }[]
    >`
      SELECT p.pending_since, e.failures, e.last_status
      FROM push_state p JOIN event_sub_state e USING (bot_id)
      WHERE bot_id = ${a.id}`;
    expect(st).toEqual({ pending_since: null, failures: 1, last_status: 413 });
  });

  it("lifts a pause only by proving the callback again, even with the same callback and secret", async () => {
    const a = await subscribed();
    await db()`
      INSERT INTO event_sub_state (bot_id, failures) VALUES (${a.id}, ${PUSH_MAX_FAILURES})
      ON CONFLICT (bot_id) DO UPDATE SET failures = ${PUSH_MAX_FAILURES}`;
    // A callback that no longer answers keeps the pause, and nothing is kept.
    answer = () => ({ status: 500 });
    const fail = await rpc(
      a.key,
      "events/subscribe",
      subParams(CALLBACK, a.secret),
    );
    expect(fail.body.error?.code).toBe(-32015);
    expect(sent).toHaveLength(1);
    expect(await wokenBy(db(), a.id)).toBe("none");
    // One that answers the fresh challenge starts with a clean record.
    answer = echo;
    sent = [];
    const ok = await rpc(
      a.key,
      "events/subscribe",
      subParams(CALLBACK, a.secret),
    );
    expect(ok.body.error).toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]?.body ?? "{}").type).toBe("verification");
    const [st] = await db()<{ failures: number }[]>`
      SELECT failures FROM event_sub_state WHERE bot_id = ${a.id}`;
    expect(st?.failures).toBe(0);
    expect(await wokenBy(db(), a.id)).toBe("event");
  });

  it("claims a bot paused on its push URL only when its subscription could wake it", async () => {
    // Carol's push URL is paused and she has no subscription: she waits,
    // unclaimed, though an adapter past the push URL exists.
    const c = await bot("carol");
    await call(pushRoute, {
      key: c.key,
      path: "/v1/me/push",
      body: { url: PUSH },
    });
    await db()`UPDATE push_state SET failures = ${PUSH_MAX_FAILURES}`;
    const b = await bot("bob");
    await message(b, "carol");
    const before = await db()<{ pending_since: Date }[]>`
      SELECT pending_since FROM push_state WHERE bot_id = ${c.id}`;
    expect(await drainPushes()).toBe(0);
    const after = await db()<{ pending_since: Date }[]>`
      SELECT pending_since FROM push_state WHERE bot_id = ${c.id}`;
    expect(after).toEqual(before);
    // Once she has one, she's claimed, and woken by it.
    const r = await rpc(c.key, "events/subscribe", subParams());
    expect(r.body.error).toBeUndefined();
    sent = [];
    expect(await drainPushes()).toBe(1);
    expect(sent.map((s) => s.url)).toEqual([CALLBACK]);
  });

  it("never sends to a callback off the provider's hosts, even one found in the table", async () => {
    const a = await subscribed();
    // Written past the app, as a bug or a hand would.
    const [k] = await db()<{ id: string }[]>`
      SELECT id FROM api_keys WHERE bot_id = ${a.id} AND revoked_at IS NULL`;
    const keyId = k?.id ?? "0";
    const [row] = await db()<{ id: string }[]>`
      INSERT INTO event_subscriptions (bot_id, key_id, sub_id, callback_url, expires_at)
      VALUES (${a.id}, ${keyId}, ${subscriptionId(a.id, "x")},
              'https://receiver.example.net/hook', now() + interval '1 day')
      RETURNING id`;
    const rowId = row?.id ?? "0";
    const s = sealSecret(a.id, Number(rowId), randomBytes(32));
    await db()`
      INSERT INTO event_secrets (subscription_id, bot_id, key_id, key_version, iv, sealed)
      VALUES (${rowId}, ${a.id}, ${keyId}, ${s.key_version}, ${s.iv}, ${s.sealed})`;
    const b = await bot("bob");
    await message(b, "alice");
    expect(await drainPushes()).toBe(1);
    expect(sent).toEqual([]);
    const [st] = await db()<
      { failures: number }[]
    >`SELECT failures FROM event_sub_state`;
    expect(st?.failures).toBe(1);
    expect(() =>
      checkRegistration(mcpEventsAdapter, "https://receiver.example.net/hook"),
    ).toThrow();
  });

  it("sends nothing whose secret won't open, and falls through", async () => {
    const a = await subscribed();
    await call(pushRoute, {
      key: a.key,
      path: "/v1/me/push",
      body: { url: PUSH },
    });
    await db()`UPDATE event_secrets SET sealed = sealed || '\\x00'::bytea`;
    const b = await bot("bob");
    await message(b, "alice");
    expect(await drainPushes()).toBe(1);
    expect(sent.map((s) => s.url)).toEqual([PUSH]);
  });
});

describe("what ends a subscription", () => {
  it("dies with a revoked key: its secret is deleted in the same change, and nothing is sent", async () => {
    const a = await subscribed();
    const r = await call(revokeRoute, { key: a.key, body: {} });
    expect(r.status).toBe(200);
    expect(await count("event_secrets")).toBe(0);
    const [live] = await db()<
      { live: boolean }[]
    >`SELECT event_sub_live(${a.id}) AS live`;
    expect(live?.live).toBe(false);
  });

  it("dies with a rotated key, and the new key must subscribe again", async () => {
    const a = await subscribed();
    const r = await call(rotateRoute, { key: a.key, body: {} });
    expect(r.status).toBe(200);
    expect(await count("event_secrets")).toBe(0);
    const b = await bot("bob");
    await message(b, "alice");
    const [s] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM push_state WHERE bot_id = ${a.id} AND pending_since IS NOT NULL`;
    expect(s?.n).toBe(0);
    expect(await drainPushes()).toBe(0);
    expect(sent).toEqual([]);
  });

  it("is suspended while the bot is frozen, and refused to it", async () => {
    const a = await subscribed();
    const b = await bot("bob");
    await message(b, "alice");
    await setFrozen(db(), "alice", true, "test");
    expect(await drainPushes()).toBe(0);
    expect(sent).toEqual([]);
    const r = await rpc(
      a.key,
      "events/subscribe",
      subParams(CALLBACK, whsec()),
    );
    expect(r.body.error ?? r.status).toBeTruthy();
    expect(sent).toEqual([]);
    expect(await count("event_secrets")).toBe(1);
    // Unfrozen, it comes back.
    await setFrozen(db(), "alice", false, "test");
    await message(b, "alice", "back");
    expect(await drainPushes()).toBe(1);
    expect(sent.map((s) => s.url)).toEqual([CALLBACK]);
  });

  it("expires at refreshBefore", async () => {
    const a = await subscribed();
    await db()`
      ALTER TABLE event_subscriptions DISABLE TRIGGER event_subscriptions_append_only`;
    try {
      await db()`UPDATE event_subscriptions SET expires_at = now() - interval '1 second'`;
    } finally {
      await db()`
        ALTER TABLE event_subscriptions ENABLE TRIGGER event_subscriptions_append_only`;
    }
    const b = await bot("bob");
    await message(b, "alice");
    expect(await drainPushes()).toBe(0);
    expect(await wokenBy(db(), a.id)).toBe("none");
    // The sweep deletes its secret, with no subscribe or revoke to do it.
    expect(await count("event_secrets")).toBe(1);
    await sweepAdapters(Date.now(), true);
    expect(await count("event_secrets")).toBe(0);
  });

  it("sweeps a retired secret past its window, and keeps the one in force", async () => {
    const a = await subscribed();
    const r = await rpc(
      a.key,
      "events/subscribe",
      subParams(CALLBACK, whsec()),
    );
    expect(r.body.error).toBeUndefined();
    expect(await count("event_secrets")).toBe(2);
    await sweepAdapters(Date.now(), true);
    expect(await count("event_secrets")).toBe(2);
    // The row the retired secret was made with expires: it still signs
    // until its own window ends.
    await db()`
      ALTER TABLE event_subscriptions DISABLE TRIGGER event_subscriptions_append_only`;
    try {
      await db()`
        UPDATE event_subscriptions SET expires_at = now() - interval '1 second'
        WHERE id = (SELECT subscription_id FROM event_secrets WHERE retire_at IS NOT NULL)`;
    } finally {
      await db()`
        ALTER TABLE event_subscriptions ENABLE TRIGGER event_subscriptions_append_only`;
    }
    await sweepAdapters(Date.now(), true);
    expect(await count("event_secrets")).toBe(2);
    await db()`UPDATE event_secrets SET retire_at = now() - interval '1 second' WHERE retire_at IS NOT NULL`;
    await sweepAdapters(Date.now(), true);
    expect(await count("event_secrets")).toBe(1);
    expect(await wokenBy(db(), a.id)).toBe("event");
  });

  it("ends on unsubscribe, which is safe to repeat and touches only the caller's own", async () => {
    const a = await subscribed("alice");
    const m = await bot("mallory");
    // Mallory names alice's callback: nothing of alice's changes.
    const r = await rpc(m.key, "events/unsubscribe", {
      name: "wake",
      arguments: {},
      delivery: { mode: "webhook", url: CALLBACK },
    });
    expect(r.body.result).toEqual({});
    expect(await count("event_secrets")).toBe(1);
    const un = {
      name: "wake",
      arguments: {},
      delivery: { mode: "webhook", url: CALLBACK },
    };
    expect((await rpc(a.key, "events/unsubscribe", un)).body.result).toEqual(
      {},
    );
    expect(await count("event_secrets")).toBe(0);
    expect((await rpc(a.key, "events/unsubscribe", un)).body.result).toEqual(
      {},
    );
    expect(await count("event_subscriptions")).toBe(2);
  });

  it("can't be made for another bot: a subscription is always the caller's own", async () => {
    await subscribed("alice");
    const m = await bot("mallory");
    const r = await rpc(m.key, "events/subscribe", subParams());
    expect(r.body.error).toBeUndefined();
    const rows = await db()<{ bot_id: string }[]>`
      SELECT DISTINCT bot_id FROM event_subscriptions WHERE callback_url IS NOT NULL`;
    expect(rows).toHaveLength(2);
    // Each bot's subscription id differs, though the callback is the same.
    expect(r.body.result.id).not.toBe(
      subscriptionId(
        Number(
          (
            await db()<
              { id: string }[]
            >`SELECT id FROM bots WHERE handle = 'alice'`
          )[0]?.id,
        ),
        CALLBACK,
      ),
    );
  });
});

describe("the lookup screen", () => {
  it("counts subscriptions, ended ones and the events that went and failed, never a callback or secret", async () => {
    const secret = whsec();
    const a = await subscribed("alice", secret);
    const b = await bot("bob");
    await message(b, "alice");
    expect(await drainPushes()).toBe(1);
    // Past both gaps, a failed event.
    answer = () => ({ status: 500 });
    await message(b, "alice", "again");
    await db()`UPDATE event_sub_state SET last_sent_at = now() - interval '1 day'`;
    await db()`UPDATE push_state SET last_sent_at = now() - interval '1 day', pending_since = now()`;
    expect(await drainPushes()).toBe(1);
    const un = {
      name: "wake",
      arguments: {},
      delivery: { mode: "webhook", url: CALLBACK },
    };
    expect((await rpc(a.key, "events/unsubscribe", un)).body.result).toEqual(
      {},
    );
    const look = await lookupBot(db(), "alice");
    expect(look?.messages).toMatchObject({
      event_subscriptions: 1,
      event_subscriptions_ended: 1,
      events_delivered: 1,
      events_failed: 1,
    });
    const text = JSON.stringify(look);
    expect(text).not.toContain("cb_1");
    expect(text).not.toContain(secret.slice("whsec_".length, 20));
    // Bob, who has none, counts nothing.
    expect((await lookupBot(db(), "bob"))?.messages).toMatchObject({
      event_subscriptions: 0,
      event_subscriptions_ended: 0,
      events_delivered: 0,
      events_failed: 0,
    });
  });
});

describe("the kill switch", () => {
  it("refuses subscribe and unsubscribe, and sends nothing", async () => {
    const a = await subscribed();
    const b = await bot("bob");
    await message(b, "alice");
    process.env.UNPROMPTED_READ_ONLY = "1";
    const r = await rpc(
      a.key,
      "events/subscribe",
      subParams(CALLBACK, whsec()),
    );
    expect(r.body.error).toMatchObject({
      code: -32000,
      data: { code: "read_only" },
    });
    const u = await rpc(a.key, "events/unsubscribe", {
      name: "wake",
      delivery: { mode: "webhook", url: CALLBACK },
    });
    expect(u.body.error?.data?.code).toBe("read_only");
    expect(await drainPushes()).toBe(0);
    await drainForAWhile(deliver, 50);
    expect(sent).toEqual([]);
    expect((await rpc(a.key, "events/list")).body.result.events).toHaveLength(
      1,
    );
  });
});
