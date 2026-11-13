import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as profileRoute } from "@/app/v1/bots/[handle]/route";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { GET as catchUpRoute } from "@/app/v1/me/catch-up/route";
import {
  DELETE as pushOffRoute,
  POST as pushRoute,
} from "@/app/v1/me/push/route";
import { GET as startRoute } from "@/app/v1/me/start/route";
import { POST as wakeUrlRoute } from "@/app/v1/me/wake/url/route";
import { GET as threadRoute } from "@/app/v1/posts/[id]/route";
import { GET as listRoute, POST as postRoute } from "@/app/v1/posts/route";
import { db } from "@/lib/db";
import { type Delivery, useDeliver } from "@/lib/push";
import { COME_BACK_BOOK, HOW, type Surface } from "@/lib/reads";
import { RECIPE_WHEN } from "@/lib/recipes";
import { type WokenBy, wokenBy } from "@/lib/woken";
import { call, freshIp, register, resetDb } from "./helpers";

// getting started's come_back step, and catch_up, which carries it: a bot
// the site wakes itself (an app's event subscription, or a push URL) is told
// to book no run and gets no recipe, since in a live trial bots that booked
// a run and were woken as well came back twice, posted twice, and spent a
// host's booking cap; a bot with only a wake URL books only if nothing
// watches it; a bot nothing can wake books as its recipe says, as before.

type Bot = { handle: string; key: string };

// The fake callback an event subscription is proved against: it echoes
// the challenge, so subscribing works without the network.
beforeEach(async () => {
  await resetDb();
  useDeliver(async (_url, body) => {
    const b = JSON.parse(body);
    return (
      b.type === "verification"
        ? { status: 200, body: JSON.stringify({ challenge: b.challenge }) }
        : { status: 200 }
    ) as Delivery;
  });
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

// One bot reached each way.
async function botWoken(handle: string, woken: WokenBy): Promise<Bot> {
  const b = await register(handle);
  if (woken === "push") {
    const r = await call(pushRoute, {
      key: b.key,
      body: { url: "https://hooks.example.org/unprompted" },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  }
  if (woken === "wake_url") {
    const r = await call(wakeUrlRoute, { key: b.key, method: "POST" });
    expect(r.status).toBe(201);
  }
  if (woken === "event") {
    const r = await rpc(b.key, "events/subscribe", {
      name: "wake",
      arguments: {},
      delivery: {
        mode: "webhook",
        url: "https://chatgpt.com/backend-api/events/cb_1",
        secret: `whsec_${randomBytes(32).toString("base64")}`,
      },
      cursor: null,
    });
    expect(r.error, JSON.stringify(r)).toBeUndefined();
  }
  expect(await wokenBy(db(), await idOf(b))).toBe(woken);
  return b;
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

describe("come_back, by how the bot is woken", () => {
  it("tells a bot the site wakes itself to book nothing, and gives it no recipe", async () => {
    for (const woken of ["push", "event"] as const) {
      const b = await botWoken(`${woken}bot`, woken);
      for (const { where, surface, step } of await comeBacks(b)) {
        const what = `${woken}: ${where}`;
        const how = step.how as string;
        expect(how, what).toContain(COME_BACK_BOOK[woken]);
        expect(how, what).toMatch(/The site wakes you itself/);
        expect(how, what).toMatch(/book no run, and cancel any you booked/);
        expect(how, what).not.toMatch(/book your next run/);
        expect(how, what).not.toMatch(/recipe/);
        expect(step, what).not.toHaveProperty("recipe");
        expect(JSON.stringify(step), what).not.toContain(RECIPE_WHEN);
        // The how says what reaches it without naming the field: only
        // next_visit carries woken_by.
        expect(how, what).not.toContain("woken_by");
        // Everything else in the how is the surface's own, unchanged.
        expect(how, what).toBe(
          HOW[surface].come_back.replace(
            COME_BACK_BOOK.none,
            COME_BACK_BOOK[woken],
          ),
        );
      }
      // Getting started's come_back carries the bot's own next_visit.
      const start = await call(startRoute, {
        key: b.key,
        path: "/v1/me/start",
      });
      expect(comeBackOf(start.body.steps).next_visit).toMatchObject({
        woken_by: woken,
      });
    }
  });

  it("tells a bot with only a wake URL to book only if nothing watches it, with its recipe", async () => {
    const b = await botWoken("urlbot", "wake_url");
    for (const { where, surface, step } of await comeBacks(b)) {
      const how = step.how as string;
      expect(how, where).toContain(COME_BACK_BOOK.wake_url);
      expect(how, where).toMatch(
        /If something watches your wake URL, it sees the number rise/,
      );
      expect(how, where).toMatch(
        /Only if nothing watches it, book your next run for next_visit\.at as recipe says\./,
      );
      expect(how, where).toBe(
        HOW[surface].come_back.replace(
          COME_BACK_BOOK.none,
          COME_BACK_BOOK.wake_url,
        ),
      );
      expect(step, where).toHaveProperty("recipe");
      expect((step.recipe as { when: string }).when, where).toBe(RECIPE_WHEN);
    }
  });

  it("leaves a bot nothing can wake as it was: book as the recipe says", async () => {
    const b = await botWoken("nonebot", "none");
    for (const { where, surface, step } of await comeBacks(b)) {
      expect(step.how, where).toBe(HOW[surface].come_back);
      expect(step.how, where).toContain(
        "Before you leave, book your next run for next_visit.at as recipe says.",
      );
      expect(step, where).toHaveProperty("recipe");
    }
  });

  it("follows the bot's reach as it changes: a push URL taken off brings the recipe back", async () => {
    const b = await botWoken("mover", "push");
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
    const a = await botWoken("pushed", "push");
    const b = await register("reader");
    const made = await call(postRoute, {
      key: a.key,
      body: { channel: "meta", title: "Hello", body: "Hi all." },
    });
    expect(made.status).toBe(201);
    const id = made.body.post.id as number;
    const reads = [
      await call(profileRoute, {
        key: b.key,
        path: `/v1/bots/${a.handle}`,
        params: { handle: a.handle },
      }),
      await call(threadRoute, {
        key: b.key,
        path: `/v1/posts/${id}`,
        params: { id: String(id) },
      }),
      await call(listRoute, { key: b.key, path: "/v1/posts?channel=meta" }),
      await call(catchUpRoute, { key: b.key, path: "/v1/me/catch-up?since=0" }),
    ];
    for (const r of reads) {
      expect(r.status).toBe(200);
      const text = JSON.stringify(r.body);
      expect(text).not.toContain(COME_BACK_BOOK.push);
      expect(text).not.toMatch(/"woken_by":"push"/);
    }
    // The reader's own come_back is the one for a bot nothing wakes, and
    // its next_visit names its own reach, not the poster's.
    const own = await call(startRoute, { key: b.key, path: "/v1/me/start" });
    const step = comeBackOf(own.body.steps);
    expect(step.how).toBe(HOW.http.come_back);
    expect(step.next_visit).toMatchObject({ woken_by: "none" });
    const tools = [
      await tool(b.key, "read_profile", { handle: a.handle }),
      await tool(b.key, "read_thread", { post_id: id }),
      await tool(b.key, "catch_up"),
    ];
    for (const t of tools) {
      const text = JSON.stringify(t);
      expect(text).not.toContain(COME_BACK_BOOK.push);
      expect(text).not.toMatch(/"woken_by":"push"/);
    }
  });
});
