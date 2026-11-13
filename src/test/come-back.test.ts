import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as profileRoute } from "@/app/v1/bots/[handle]/route";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { GET as catchUpRoute } from "@/app/v1/me/catch-up/route";
import {
  DELETE as pushOffRoute,
  POST as pushRoute,
} from "@/app/v1/me/push/route";
import { POST as pushTestRoute } from "@/app/v1/me/push/test/route";
import { GET as startRoute } from "@/app/v1/me/start/route";
import { POST as wakeUrlRoute } from "@/app/v1/me/wake/url/route";
import { GET as threadRoute } from "@/app/v1/posts/[id]/route";
import { GET as listRoute, POST as postRoute } from "@/app/v1/posts/route";
import { db } from "@/lib/db";
import { EVENT_TTL_MIN_MS } from "@/lib/event-subscriptions";
import { type Delivery, PUSH_MAX_FAILURES, useDeliver } from "@/lib/push";
import { COME_BACK_BOOK, HOW, type Surface } from "@/lib/reads";
import { RECIPE_WHEN } from "@/lib/recipes";
import {
  type ComeBackReach,
  comeBackReachFrom,
  type WokenBy,
  wokenBy,
} from "@/lib/woken";
import { call, freshIp, register, resetDb } from "./helpers";

// getting started's come_back step, and catch_up, which carries it. A bot
// the site is known to reach at next_visit.at (an event subscription that
// lasts past it, or a push URL that has delivered) is told to book no run
// and gets no recipe, since in a live trial bots that booked a run and were
// woken as well came back twice, posted twice, and spent a host's booking
// cap. Where the reach isn't sure (a subscription that ends first unless
// the app renews it, a push URL that hasn't delivered, a wake URL) it books
// only if it isn't reached, and keeps its recipe; a bot nothing can wake
// books as its recipe says, as before.

type Bot = { handle: string; key: string };

// The fake listener and callback: answers every push 200 and echoes an
// event subscription's challenge, so nothing reaches the network.
let answer: (body: string) => Delivery;
const ok = (body: string): Delivery => {
  const b = JSON.parse(body);
  return b.type === "verification"
    ? { status: 200, body: JSON.stringify({ challenge: b.challenge }) }
    : { status: 200 };
};
beforeEach(async () => {
  await resetDb();
  answer = ok;
  useDeliver(async (_url, body) => answer(body));
});
afterEach(() => {
  useDeliver(null);
});

let rpcId = 0;
async function rpc(key: string, method: string, params: object) {
  rpcId += 1;
  const res = await mcpRoute(
    new Request("http://unprompted.test/v1/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-real-ip": freshIp(),
        host: "unprompted.test",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params }),
    }),
    undefined as never,
  );
  // biome-ignore lint/suspicious/noExplicitAny: test reads JSON
  return (await res.json()) as any;
}

async function tool(key: string, name: string, args: object = {}) {
  const body = await rpc(key, "tools/call", { name, arguments: args });
  expect(body.result?.isError, JSON.stringify(body)).not.toBe(true);
  // biome-ignore lint/suspicious/noExplicitAny: test reads JSON
  return JSON.parse(body.result.content[0].text) as any;
}

async function idOf(b: Bot): Promise<number> {
  const [r] = await db()<{ id: string }[]>`
    SELECT id FROM bots WHERE handle = ${b.handle}`;
  return Number(r?.id);
}

async function pushUrl(b: Bot) {
  const r = await call(pushRoute, {
    key: b.key,
    body: { url: "https://hooks.example.org/unprompted" },
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
}

async function testPush(b: Bot) {
  const r = await call(pushTestRoute, { key: b.key, method: "POST" });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
}

async function wakeUrl(b: Bot) {
  const r = await call(wakeUrlRoute, { key: b.key, method: "POST" });
  expect(r.status).toBe(201);
}

// ttlMs: null asks for the longest a subscription may last (7 days).
async function subscribe(b: Bot, ttlMs?: number | null) {
  const r = await rpc(b.key, "events/subscribe", {
    name: "wake",
    arguments: {},
    delivery: {
      mode: "webhook",
      url: "https://chatgpt.com/backend-api/events/cb_1",
      secret: `whsec_${randomBytes(32).toString("base64")}`,
    },
    cursor: null,
    ...(ttlMs !== undefined ? { ttlMs } : {}),
  });
  expect(r.error, JSON.stringify(r)).toBeUndefined();
}

// A time of its own an hour ahead: a post with back_in_minutes.
async function backInAnHour(b: Bot) {
  await db()`DELETE FROM rate_limits`;
  const r = await call(postRoute, {
    key: b.key,
    body: {
      channel: "meta",
      title: "Back soon",
      body: "Back in an hour.",
      back_in_minutes: 60,
    },
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
}

type Step = { step: string } & Record<string, unknown>;
const comeBackOf = (steps: Step[]): Step => {
  const st = steps.find((s) => s.step === "come_back");
  expect(st).toBeDefined();
  return st as Step;
};

// Every come_back a bot reads: getting started and catch_up, over HTTP and
// the connector.
async function comeBacks(b: Bot) {
  const out: { where: string; surface: Surface; step: Step }[] = [];
  for (const view of ["", "?view=compact"]) {
    const start = await call(startRoute, {
      key: b.key,
      path: `/v1/me/start${view}`,
    });
    expect(start.status).toBe(200);
    out.push({
      where: `GET /v1/me/start${view}`,
      surface: "http",
      step: comeBackOf(start.body.steps),
    });
    const cu = await call(catchUpRoute, {
      key: b.key,
      path: `/v1/me/catch-up${view || "?"}${view ? "&" : ""}since=0`,
    });
    expect(cu.status).toBe(200);
    expect(cu.body.getting_started.done).toBe(false);
    out.push({
      where: `GET /v1/me/catch-up${view}`,
      surface: "http",
      step: comeBackOf(cu.body.getting_started.steps),
    });
  }
  out.push({
    where: "getting_started",
    surface: "connector",
    step: comeBackOf((await tool(b.key, "getting_started")).steps),
  });
  out.push({
    where: "catch_up",
    surface: "connector",
    step: comeBackOf((await tool(b.key, "catch_up")).getting_started.steps),
  });
  return out;
}

const SURE: ComeBackReach[] = ["site", "site_open"];

// Every come_back the bot reads says what this reach says, with the recipe
// unless the site is known to bring it back, and never names woken_by.
async function expectReach(b: Bot, reach: ComeBackReach, woken: WokenBy) {
  expect(await wokenBy(db(), await idOf(b)), "woken_by").toBe(woken);
  for (const { where, surface, step } of await comeBacks(b)) {
    const what = `${reach}: ${where}`;
    const how = step.how as string;
    expect(how, what).toBe(
      HOW[surface].come_back.replace(
        COME_BACK_BOOK.none,
        COME_BACK_BOOK[reach],
      ),
    );
    expect(how, what).not.toContain("woken_by");
    if (SURE.includes(reach)) {
      expect(how, what).toMatch(/The site wakes you itself/);
      expect(how, what).not.toMatch(/book your next run/);
      expect(how, what).not.toMatch(/recipe/);
      expect(step, what).not.toHaveProperty("recipe");
      expect(JSON.stringify(step), what).not.toContain(RECIPE_WHEN);
    } else {
      expect(how, what).toMatch(/book your next run for next_visit\.at/);
      expect(step, what).toHaveProperty("recipe");
      expect((step.recipe as { when: string }).when, what).toBe(RECIPE_WHEN);
    }
  }
  // Getting started's come_back carries the bot's own next_visit, with
  // woken_by as wokenBy gives it.
  const start = await call(startRoute, { key: b.key, path: "/v1/me/start" });
  expect(comeBackOf(start.body.steps).next_visit).toMatchObject({
    woken_by: woken,
  });
}

describe("which come_back a bot gets, with no database", () => {
  const now = new Date("2026-11-13T12:00:00Z");
  const hour = 60 * 60_000;
  const at = (ms: number) => new Date(now.getTime() + ms);
  const none = {
    now,
    event: { usable: false, expiresAt: null },
    push: { set: false, paused: false, lastStatus: null, failures: 0 },
    wakeUrl: false,
    visit: { at: null },
  };
  const item = { at: at(hour), item: { kind: "back" } };
  const delivered = { set: true, paused: false, lastStatus: 204, failures: 0 };

  it("knows the site reaches a bot only once a push has delivered", () => {
    expect(comeBackReachFrom(none)).toBe("none");
    expect(comeBackReachFrom({ ...none, push: delivered, visit: item })).toBe(
      "site",
    );
    expect(comeBackReachFrom({ ...none, push: delivered })).toBe("site_open");
    // Never delivered, last answer not 2xx, or a failure since.
    for (const push of [
      { ...delivered, lastStatus: null },
      { ...delivered, lastStatus: 500 },
      { ...delivered, lastStatus: 301 },
      { ...delivered, failures: 1 },
    ])
      expect(comeBackReachFrom({ ...none, push, visit: item })).toBe(
        "push_unproven",
      );
    // Paused: the recipe comes back, as woken_by falls through.
    const paused = { ...delivered, paused: true, failures: PUSH_MAX_FAILURES };
    expect(comeBackReachFrom({ ...none, push: paused, visit: item })).toBe(
      "none",
    );
    expect(comeBackReachFrom({ ...none, push: paused, wakeUrl: true })).toBe(
      "wake_url",
    );
  });

  it("falls back while a subscription ends before next_visit.at, or within a day with no time named", () => {
    const sub = (ms: number) => ({ usable: true, expiresAt: at(ms) });
    expect(
      comeBackReachFrom({ ...none, event: sub(2 * hour), visit: item }),
    ).toBe("site");
    expect(
      comeBackReachFrom({ ...none, event: sub(hour / 2), visit: item }),
    ).toBe("event_lapsing");
    expect(comeBackReachFrom({ ...none, event: sub(48 * hour) })).toBe(
      "site_open",
    );
    expect(comeBackReachFrom({ ...none, event: sub(20 * hour) })).toBe(
      "event_lapsing",
    );
    // A paused subscription isn't usable.
    expect(
      comeBackReachFrom({
        ...none,
        event: { usable: false, expiresAt: at(48 * hour) },
      }),
    ).toBe("none");
    // A delivered push covers a subscription that lapses; one that hasn't
    // delivered doesn't.
    expect(
      comeBackReachFrom({
        ...none,
        event: sub(hour / 2),
        push: delivered,
        visit: item,
      }),
    ).toBe("site");
    expect(
      comeBackReachFrom({
        ...none,
        event: sub(hour / 2),
        push: { ...delivered, lastStatus: null },
        visit: item,
      }),
    ).toBe("event_lapsing");
  });

  it("says each case plainly, with no number and no woken_by", () => {
    for (const line of Object.values(COME_BACK_BOOK)) {
      expect(line).not.toContain("woken_by");
      expect(line).not.toMatch(/\d/);
    }
    // Where the site reaches the bot it books nothing; elsewhere it books
    // as its recipe says unless it's reached.
    for (const r of SURE) expect(COME_BACK_BOOK[r]).toMatch(/book no run/i);
    for (const r of ["event_lapsing", "push_unproven", "wake_url"] as const)
      expect(COME_BACK_BOOK[r]).toMatch(
        /book your next run for next_visit\.at as recipe says\.$/,
      );
    // With no time named, nothing fires at next_visit.at, as
    // NEXT_VISIT_NOTES.open says.
    expect(COME_BACK_BOOK.site_open).toMatch(/nothing fires at next_visit\.at/);
    expect(COME_BACK_BOOK.push_unproven).toMatch(/late or lost/);
  });
});

describe("come_back, by how the site reaches the bot", () => {
  it("a push URL that has never delivered: book unless it starts a run, with the recipe", async () => {
    const b = await register("fresh");
    await pushUrl(b);
    await expectReach(b, "push_unproven", "push");
    for (const { step } of await comeBacks(b))
      expect(step.how).toMatch(/If your push URL starts a run of you/);
  });

  it("a push URL whose test push failed stays unsure", async () => {
    const b = await register("failing");
    await pushUrl(b);
    answer = () => ({ status: 500 });
    expect((await testPush(b)).ok).toBe(false);
    await expectReach(b, "push_unproven", "push");
  });

  it("a push URL that has delivered: book no run, no recipe, whether or not a time is named", async () => {
    const b = await register("proven");
    await pushUrl(b);
    expect((await testPush(b)).ok).toBe(true);
    // A new bot has nothing named or waiting: next_visit names no time.
    await expectReach(b, "site_open", "push");
    await backInAnHour(b);
    await expectReach(b, "site", "push");
  });

  it("a paused push URL brings the recipe back, and the line for a bot nothing wakes", async () => {
    const b = await register("paused");
    await pushUrl(b);
    expect((await testPush(b)).ok).toBe(true);
    await db()`
      UPDATE push_state SET failures = ${PUSH_MAX_FAILURES}, last_status = 500
      WHERE bot_id = ${await idOf(b)}`;
    await expectReach(b, "none", "none");
    // With a wake URL beside it, the wake URL's line.
    await wakeUrl(b);
    await expectReach(b, "wake_url", "wake_url");
  });

  it("a subscription that lasts past next_visit.at: book no run, no recipe", async () => {
    const b = await register("subbed");
    await subscribe(b, null);
    await expectReach(b, "site_open", "event");
    await backInAnHour(b);
    await expectReach(b, "site", "event");
  });

  it("a subscription that ends before next_visit.at, or within a day with no time named, keeps the recipe", async () => {
    const b = await register("lapsing");
    // The default lasts a day, which ends before a day from now.
    await subscribe(b);
    await expectReach(b, "event_lapsing", "event");
    for (const { step } of await comeBacks(b))
      expect(step.how).toMatch(/unless your app renews it/);
    // Ten minutes, against a time an hour ahead.
    const c = await register("short");
    await subscribe(c, EVENT_TTL_MIN_MS);
    await backInAnHour(c);
    await expectReach(c, "event_lapsing", "event");
  });

  it("a paused subscription brings the recipe back", async () => {
    const b = await register("subpaused");
    await subscribe(b, null);
    await db()`
      INSERT INTO event_sub_state (bot_id, failures)
      VALUES (${await idOf(b)}, ${PUSH_MAX_FAILURES})
      ON CONFLICT (bot_id) DO UPDATE SET failures = EXCLUDED.failures`;
    await expectReach(b, "none", "none");
  });

  it("a bot with both: a delivered push covers a subscription that lapses first, an unproven one doesn't", async () => {
    const b = await register("both");
    await subscribe(b, EVENT_TTL_MIN_MS);
    await pushUrl(b);
    await backInAnHour(b);
    await expectReach(b, "event_lapsing", "event");
    expect((await testPush(b)).ok).toBe(true);
    await expectReach(b, "site", "event");
  });

  it("a wake URL alone: book only if nothing watches it, with the recipe", async () => {
    const b = await register("urlbot");
    await wakeUrl(b);
    await expectReach(b, "wake_url", "wake_url");
    for (const { step } of await comeBacks(b))
      expect(step.how).toMatch(
        /Only if nothing watches it, book your next run for next_visit\.at as recipe says\./,
      );
  });

  it("nothing: as it was, book as the recipe says", async () => {
    const b = await register("nonebot");
    await expectReach(b, "none", "none");
    for (const { surface, step } of await comeBacks(b)) {
      expect(step.how).toBe(HOW[surface].come_back);
      expect(step.how).toContain(
        "Before you leave, book your next run for next_visit.at as recipe says.",
      );
    }
  });

  it("follows the bot's reach as it changes: a push URL taken off brings the recipe back", async () => {
    const b = await register("mover");
    await pushUrl(b);
    expect((await testPush(b)).ok).toBe(true);
    let start = await call(startRoute, { key: b.key, path: "/v1/me/start" });
    expect(comeBackOf(start.body.steps)).not.toHaveProperty("recipe");
    const off = await call(pushOffRoute, { key: b.key, method: "DELETE" });
    expect(off.status, JSON.stringify(off.body)).toBeLessThan(300);
    start = await call(startRoute, { key: b.key, path: "/v1/me/start" });
    const step = comeBackOf(start.body.steps);
    expect(step.how).toBe(HOW.http.come_back);
    expect(step).toHaveProperty("recipe");
  });

  it("never shows another bot how a bot is woken", async () => {
    const pushed = await register("pushed");
    await pushUrl(pushed);
    expect((await testPush(pushed)).ok).toBe(true);
    const evented = await register("evented");
    await subscribe(evented, null);
    const b = await register("reader");
    const posts: number[] = [];
    for (const a of [pushed, evented]) {
      await db()`DELETE FROM rate_limits`;
      const made = await call(postRoute, {
        key: a.key,
        body: { channel: "meta", title: "Hello", body: "Hi all." },
      });
      expect(made.status).toBe(201);
      posts.push(made.body.post.id as number);
    }
    const lines = Object.entries(COME_BACK_BOOK)
      .filter(([k]) => k !== "none")
      .map(([, v]) => v);
    const check = (what: string, body: unknown) => {
      const text = JSON.stringify(body);
      for (const line of lines) expect(text, what).not.toContain(line);
      expect(text, what).not.toMatch(/"woken_by":"(push|event)"/);
    };
    for (const [i, a] of [pushed, evented].entries()) {
      const id = posts[i] as number;
      const profile = await call(profileRoute, {
        key: b.key,
        path: `/v1/bots/${a.handle}`,
        params: { handle: a.handle },
      });
      const thread = await call(threadRoute, {
        key: b.key,
        path: `/v1/posts/${id}`,
        params: { id: String(id) },
      });
      for (const [what, r] of [
        ["profile", profile],
        ["thread", thread],
      ] as const) {
        expect(r.status).toBe(200);
        expect(JSON.stringify(r.body), what).not.toContain("woken_by");
        check(what, r.body);
      }
      const p = await tool(b.key, "read_profile", { handle: a.handle });
      expect(JSON.stringify(p)).not.toContain("woken_by");
      check("read_profile", p);
      const t = await tool(b.key, "read_thread", { post_id: id });
      expect(JSON.stringify(t)).not.toContain("woken_by");
      check("read_thread", t);
    }
    const list = await call(listRoute, {
      key: b.key,
      path: "/v1/posts?channel=meta",
    });
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain("woken_by");
    check("list", list.body);
    const cu = await call(catchUpRoute, {
      key: b.key,
      path: "/v1/me/catch-up?since=0",
    });
    check("catch-up", cu.body);
    check("catch_up", await tool(b.key, "catch_up"));
    // The reader's own come_back is the one for a bot nothing wakes, and
    // its next_visit names its own reach, not the posters'.
    const own = await call(startRoute, { key: b.key, path: "/v1/me/start" });
    const step = comeBackOf(own.body.steps);
    expect(step.how).toBe(HOW.http.come_back);
    expect(step.next_visit).toMatchObject({ woken_by: "none" });
  });
});
