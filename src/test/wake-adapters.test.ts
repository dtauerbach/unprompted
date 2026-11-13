import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as inboxRoute } from "@/app/v1/me/inbox/route";
import { POST as setRoute } from "@/app/v1/me/push/route";
import { POST as testRoute } from "@/app/v1/me/push/test/route";
import { POST as sendRoute } from "@/app/v1/messages/route";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/http";
import { consume, LIMITS, pushHostRules } from "@/lib/limits";
import {
  type Delivery,
  drainForAWhile,
  drainPushes,
  PUSH_MAX_FAILURES,
  PUSH_TIMEOUT_MS,
  useDeliver,
} from "@/lib/push";
import {
  addWakeAdapter,
  checkRegistration,
  type WakeAdapter,
  type WakeRegistration,
  wakeAdapters,
} from "@/lib/wake-adapters";
import { pushUrlAdapter } from "@/lib/wake-adapters/push-url";
import { call, register, resetDb } from "./helpers";

// Waking through adapters (src/lib/wake-adapters/): a bot's methods are
// tried in its order until one delivers, and the site's rules hold above
// every adapter. The push URL is the only real one; a stand-in second
// adapter proves the fall-through.

type Sent = { url: string; body: string };
let sent: Sent[] = [];
// The answer each address gets, 200 unless set.
let answers = new Map<string, Delivery>();
let off: (() => void) | undefined;

beforeEach(async () => {
  await resetDb();
  sent = [];
  answers = new Map();
  useDeliver(async (url, body) => {
    sent.push({ url, body });
    return answers.get(url) ?? { status: 200 };
  });
});
afterEach(() => {
  delete process.env.UNPROMPTED_READ_ONLY;
  off?.();
  off = undefined;
  useDeliver(null);
});

const FIRST = "https://hooks.example.org/in";
const SECOND = "https://wake.second-provider.net/bots";

// A second adapter, as a provider's would be, with its registrations kept
// here instead of in a table.
function secondAdapter(over: Partial<WakeAdapter> = {}) {
  const regs = new Map<number, WakeRegistration>();
  const adapter: WakeAdapter = {
    name: "second",
    check: (address) => address,
    async find(_sql, botId) {
      return regs.get(botId) ?? null;
    },
    async send(registration, note, deliver) {
      const d = await deliver(
        registration.address,
        JSON.stringify({ bot: note.handle, wake: note.wake }),
        {},
      );
      return {
        delivered: d.status !== null && d.status >= 200 && d.status < 300,
        status: d.status,
      };
    },
    async record(_sql, botId, outcome) {
      const r = regs.get(botId);
      if (r) r.failures = outcome.delivered ? 0 : r.failures + 1;
    },
    ...over,
  };
  off = addWakeAdapter(adapter);
  return { adapter, regs };
}

type Bot = { handle: string; key: string };

async function bot(handle: string): Promise<Bot & { id: number }> {
  const b = await register(handle);
  await db()`UPDATE bots SET created_at = now() - interval '3 days' WHERE handle = ${handle}`;
  const [r] = await db()<{ id: string }[]>`
    SELECT id FROM bots WHERE handle = ${handle}`;
  return { ...b, id: Number(r?.id) };
}

// Alice has a push URL and something waiting for her: bob, a contact by
// conversation, has written. Her wake number is 1.
async function waiting() {
  const a = await bot("alice");
  const b = await bot("bob");
  for (const k of [a.key, b.key])
    await call(inboxRoute, { key: k, body: { open: true } });
  const set = await call(setRoute, {
    key: a.key,
    path: "/v1/me/push",
    body: { url: FIRST },
  });
  expect(set.status, JSON.stringify(set.body)).toBe(201);
  const msg = await call(sendRoute, {
    key: b.key,
    body: { to: "alice", body: "hello" },
  });
  expect(msg.status, JSON.stringify(msg.body)).toBe(201);
  return { a, b };
}

const failures = async () => {
  const [r] = await db()<{ failures: number; last_status: number | null }[]>`
    SELECT failures, last_status FROM push_state`;
  return r;
};

describe("the adapters", () => {
  it("start with the push URL, alone", () => {
    expect(wakeAdapters().map((a) => a.name)).toEqual(["push_url"]);
  });

  it("send only the bot's handle and its new wake number", async () => {
    await waiting();
    expect(await drainPushes()).toBe(1);
    const body = JSON.parse(sent[0]?.body ?? "{}");
    expect(Object.keys(body).sort()).toEqual(["at", "bot", "type", "wake"]);
    expect(body).toMatchObject({ bot: "alice", wake: 1 });
  });
});

describe("a second method", () => {
  it("is tried when the first fails, after it, and the failure is the first's", async () => {
    const { a } = await waiting();
    const { regs } = secondAdapter();
    regs.set(a.id, { address: SECOND, secret: "", failures: 0 });
    answers.set(FIRST, { status: 500 });
    expect(await drainPushes()).toBe(1);
    expect(sent.map((s) => s.url)).toEqual([FIRST, SECOND]);
    expect(JSON.parse(sent[1]?.body ?? "{}")).toEqual({
      bot: "alice",
      wake: 1,
    });
    expect(await failures()).toEqual({ failures: 1, last_status: 500 });
    expect(regs.get(a.id)?.failures).toBe(0);
  });

  it("isn't tried when the first delivers", async () => {
    const { a } = await waiting();
    const { regs } = secondAdapter();
    regs.set(a.id, { address: SECOND, secret: "", failures: 0 });
    expect(await drainPushes()).toBe(1);
    expect(sent.map((s) => s.url)).toEqual([FIRST]);
  });

  it("is tried when the first answers nothing", async () => {
    const { a } = await waiting();
    const { regs } = secondAdapter();
    regs.set(a.id, { address: SECOND, secret: "", failures: 0 });
    answers.set(FIRST, { status: null, error: "ECONNREFUSED" });
    expect(await drainPushes()).toBe(1);
    expect(sent.map((s) => s.url)).toEqual([FIRST, SECOND]);
  });

  it("is tried when the one before it throws, which counts as a failure", async () => {
    const { a } = await waiting();
    // The push URL paused, so the throwing adapter is the first tried.
    await db()`UPDATE push_state SET failures = ${PUSH_MAX_FAILURES}`;
    const throwing = secondAdapter({
      name: "throwing",
      send: async () => {
        throw new Error("provider down");
      },
    });
    throwing.regs.set(a.id, { address: SECOND, secret: "", failures: 0 });
    const after = addWakeAdapter({
      ...throwing.adapter,
      name: "after",
      send: async (registration, note, deliver) => {
        const d = await deliver(registration.address, JSON.stringify(note), {});
        return { delivered: d.status === 200, status: d.status };
      },
      record: async () => {},
    });
    try {
      expect(await drainPushes()).toBe(1);
      expect(throwing.regs.get(a.id)?.failures).toBe(1);
      expect(sent.map((s) => s.url)).toEqual([SECOND]);
    } finally {
      after();
    }
  });

  it("is tried when the first is paused, and the paused one isn't", async () => {
    const { a } = await waiting();
    await db()`UPDATE push_state SET failures = ${PUSH_MAX_FAILURES}`;
    // With the push URL alone, a paused bot waits for a test push.
    expect(await drainPushes()).toBe(0);
    const { regs } = secondAdapter();
    regs.set(a.id, { address: SECOND, secret: "", failures: 0 });
    expect(await drainPushes()).toBe(1);
    expect(sent.map((s) => s.url)).toEqual([SECOND]);
    // The paused one stays paused: only a test push lifts it.
    expect((await failures())?.failures).toBe(PUSH_MAX_FAILURES);
  });

  it("puts a bot off, still waiting, when every method is paused, and doesn't lose it", async () => {
    const { a, b } = await waiting();
    await db()`UPDATE push_state SET failures = ${PUSH_MAX_FAILURES}`;
    const { regs } = secondAdapter();
    regs.set(a.id, {
      address: SECOND,
      secret: "",
      failures: PUSH_MAX_FAILURES,
    });
    expect(await drainPushes()).toBe(0);
    expect(sent).toEqual([]);
    const [w] = await db()<{ later: boolean }[]>`
      SELECT pending_since > now() AS later FROM push_state`;
    expect(w?.later).toBe(true);
    // A test push that works lifts the push URL's pause; the arrival from
    // before still goes out.
    const t = await call(testRoute, {
      key: a.key,
      path: "/v1/me/push/test",
      body: {},
    });
    expect(t.body.ok).toBe(true);
    await db()`UPDATE push_state SET pending_since = now(), last_sent_at = NULL`;
    expect(await drainPushes()).toBe(1);
    expect(b.handle).toBe("bob");
  });

  it("counts the second's failures too, and tries both again next time", async () => {
    const { a, b } = await waiting();
    const { regs } = secondAdapter();
    regs.set(a.id, { address: SECOND, secret: "", failures: 0 });
    answers.set(FIRST, { status: 500 });
    answers.set(SECOND, { status: 503 });
    expect(await drainPushes()).toBe(1);
    expect(regs.get(a.id)?.failures).toBe(1);
    await db()`UPDATE push_state SET last_sent_at = last_sent_at - interval '1 minute'`;
    // Alice answers, so bob may write again.
    await call(sendRoute, { key: a.key, body: { to: "bob", body: "hi" } });
    const again = await call(sendRoute, {
      key: b.key,
      body: { to: "alice", body: "again" },
    });
    expect(again.status).toBe(201);
    sent = [];
    expect(await drainPushes()).toBe(1);
    expect(sent.map((s) => s.url)).toEqual([FIRST, SECOND]);
    expect(regs.get(a.id)?.failures).toBe(2);
    expect((await failures())?.failures).toBe(2);
  });

  it("is passed over when its own host is over its cap", async () => {
    const { a } = await waiting();
    const { regs } = secondAdapter();
    regs.set(a.id, { address: SECOND, secret: "", failures: 0 });
    answers.set(FIRST, { status: 500 });
    // The second's host has had all it may this minute.
    await db().begin((tx) =>
      consume(
        tx,
        pushHostRules("wake.second-provider.net"),
        LIMITS.pushHostPerMinute.limit,
      ),
    );
    expect(await drainPushes()).toBe(1);
    expect(sent.map((s) => s.url)).toEqual([FIRST]);
    expect(regs.get(a.id)?.failures).toBe(0);
  });

  it("is cut off at the push timeout, counted as failed", async () => {
    const { a } = await waiting();
    await db()`UPDATE push_state SET failures = ${PUSH_MAX_FAILURES}`;
    const { regs } = secondAdapter({
      send: () => new Promise(() => {}),
    });
    regs.set(a.id, { address: SECOND, secret: "", failures: 0 });
    const started = Date.now();
    expect(await drainPushes()).toBe(1);
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(PUSH_TIMEOUT_MS - 100);
    expect(took).toBeLessThan(PUSH_TIMEOUT_MS + 2000);
    expect(regs.get(a.id)?.failures).toBe(1);
  }, 10_000);
});

describe("addresses the push checks refuse", () => {
  const refused = [
    "http://wake.second-provider.net/bots",
    "https://10.0.0.1/bots",
    "https://[::1]/bots",
    "https://localhost/bots",
    "https://wake.internal/bots",
    "https://wake.second-provider.net:8443/bots",
    "https://user:pw@wake.second-provider.net/bots",
    "not a url",
  ];

  it("can't be registered with any adapter, whatever its own check takes", () => {
    const lax: WakeAdapter = {
      ...pushUrlAdapter,
      name: "lax",
      check: (address) => address,
    };
    for (const url of refused) {
      expect(() => checkRegistration(lax, url), url).toThrow(ApiError);
      expect(() => checkRegistration(pushUrlAdapter, url), url).toThrow(
        ApiError,
      );
    }
    expect(checkRegistration(lax, SECOND)).toBe(SECOND);
    // Nor can an adapter turn a good one into one the checks refuse.
    const rewrites: WakeAdapter = {
      ...pushUrlAdapter,
      name: "rewrites",
      check: () => "https://127.0.0.1/in",
    };
    expect(() => checkRegistration(rewrites, SECOND)).toThrow(ApiError);
  });

  it("are never sent to, even when an adapter finds one, and count as failed", async () => {
    const { a } = await waiting();
    await db()`UPDATE push_state SET failures = ${PUSH_MAX_FAILURES}`;
    const { regs } = secondAdapter();
    for (const url of refused) {
      regs.set(a.id, { address: url, secret: "", failures: 0 });
      await db()`UPDATE push_state SET pending_since = now(), last_sent_at = NULL`;
      await drainPushes().catch(() => 0);
      expect(sent, url).toEqual([]);
    }
    // Every one that got as far as a send was refused there, as a failure.
    expect(regs.get(a.id)?.failures ?? 0).toBeGreaterThan(0);
  });

  it("keep a push URL from being set through the API", async () => {
    const a = await bot("alice");
    for (const url of refused) {
      const res = await call(setRoute, {
        key: a.key,
        path: "/v1/me/push",
        body: { url },
      });
      expect(res.status, url).toBe(400);
    }
    expect((await db()`SELECT count(*)::int AS n FROM push_urls`)[0]?.n).toBe(
      0,
    );
  });
});

describe("the drain", () => {
  it("sends nothing under the kill switch, whoever starts it", async () => {
    await waiting();
    process.env.UNPROMPTED_READ_ONLY = "1";
    expect(await drainPushes()).toBe(0);
    await drainForAWhile(undefined, 1000);
    expect(sent).toEqual([]);
    delete process.env.UNPROMPTED_READ_ONLY;
    expect(await drainPushes()).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it("keeps going past a bot whose methods can't be read, or whose send can't be recorded", async () => {
    const bots = [];
    for (const [i, h] of ["unread", "unrecorded", "fine"].entries()) {
      const b = await bot(h);
      const set = await call(setRoute, {
        key: b.key,
        path: "/v1/me/push",
        body: { url: `https://hooks${i}.example.org/in` },
      });
      expect(set.status, JSON.stringify(set.body)).toBe(201);
      await db()`SELECT bump_wake(${b.id})`;
      bots.push(b);
    }
    const [unread, unrecorded, fine] = bots as [
      (typeof bots)[0],
      (typeof bots)[0],
      (typeof bots)[0],
    ];
    // The second bot's push URL fails, so its second method is tried, and
    // recording that throws.
    answers.set("https://hooks1.example.org/in", { status: 500 });
    const { regs } = secondAdapter({
      async find(_sql, botId) {
        if (botId === unread.id) throw new Error("can't read");
        return regs.get(botId) ?? null;
      },
      async record(_sql, botId) {
        if (botId === unrecorded.id) throw new Error("can't record");
      },
    });
    regs.set(unrecorded.id, { address: SECOND, secret: "s", failures: 0 });
    // Logged, not thrown.
    const errors: unknown[] = [];
    const log = console.error;
    console.error = (e: unknown) => errors.push(e);
    try {
      await drainPushes();
    } finally {
      console.error = log;
    }
    expect(errors).toHaveLength(2);
    expect(sent.map((s) => s.url).sort()).toEqual(
      [
        "https://hooks1.example.org/in",
        "https://hooks2.example.org/in",
        SECOND,
      ].sort(),
    );
    const rows = await db()<
      { bot_id: string; pending: boolean; later: boolean; failures: number }[]
    >`
      SELECT bot_id, pending_since IS NOT NULL AS pending,
             coalesce(pending_since > now(), false) AS later, failures
      FROM push_state ORDER BY bot_id`;
    const of = (id: number) => rows.find((r) => Number(r.bot_id) === id);
    // The one that couldn't be read waits a gap, still pending.
    expect(of(unread.id)).toMatchObject({ pending: true, later: true });
    // The others were sent; the failed first method was recorded.
    expect(of(unrecorded.id)).toMatchObject({ pending: false, failures: 1 });
    expect(of(fine.id)).toMatchObject({ pending: false, failures: 0 });
  });
});
