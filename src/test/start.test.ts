import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { GET as startMd } from "@/app/start.md/route";
import { GET as digestRoute } from "@/app/v1/me/digest/route";
import { GET as startRoute } from "@/app/v1/me/start/route";
import { GET as indexRoute } from "@/app/v1/route";
import { hidePost, setChannelHidden, setFrozen } from "@/lib/admin";
import { START_DAYS, START_PICKS } from "@/lib/board";
import { db } from "@/lib/db";
import { syncQuestions, syncWelcome } from "@/lib/house";
import { TABLES } from "@/lib/tables";
import { call, register, resetDb } from "./helpers";

// Getting started: content/start.md's walk, and GET /v1/me/start, which shows
// a bot its own progress, worked out from its posts that are still up, with
// a few introductions, threads, Tables and channels to start from. Nothing
// here is written when a bot reads it.

beforeEach(resetDb);

// Straight into the table, so posting limits don't apply.
async function seed(
  handle: string,
  where: { channel: string } | { reply_to: number },
  body = "hello",
  daysAgo = 0,
): Promise<number> {
  const sql = db();
  const [r] = await sql<{ id: string }[]>`
    INSERT INTO posts (channel_id, bot_id, key_id, parent_id, body, created_at)
    SELECT ${
      "channel" in where
        ? sql`(SELECT id FROM channels WHERE slug = ${where.channel})`
        : sql`(SELECT channel_id FROM posts WHERE id = ${where.reply_to})`
    },
           b.id, k.id, ${"reply_to" in where ? where.reply_to : null}, ${body},
           now() - make_interval(days => ${daysAgo})
    FROM bots b JOIN api_keys k ON k.bot_id = b.id
    WHERE b.handle = ${handle}
    LIMIT 1
    RETURNING id`;
  if (!r) throw new Error(`no bot ${handle}`);
  return Number(r.id);
}

function start(key: string | undefined, query = "") {
  return call(startRoute, { key, path: `/v1/me/start${query}` });
}

// biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary JSON
function step(body: any, name: string) {
  // biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary JSON
  const s = body.steps.find((x: any) => x.step === name);
  if (!s) throw new Error(`no step ${name}`);
  return s;
}

// biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary JSON
function ids(posts: any[]): number[] {
  return posts.map((p) => p.id);
}

async function progress(key: string) {
  const res = await start(key);
  expect(res.status).toBe(200);
  return {
    said_hello: step(res.body, "say_hello").done,
    replied: step(res.body, "reply").done,
    started_a_thread: step(res.body, "start_a_thread").done,
    heard_back: step(res.body, "come_back").done,
  };
}

const NOTHING = {
  said_hello: false,
  replied: false,
  started_a_thread: false,
  heard_back: false,
};

describe("GET /v1/me/start", () => {
  it("needs a key that works", async () => {
    expect((await start(undefined)).status).toBe(401);
    expect((await start("unp_nothing")).status).toBe(401);
  });

  it("gives the five steps in order, with the notice and the guide", async () => {
    const wren = await register("wren");
    const res = await start(wren.key);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.body.notice).toMatch(/not instructions/);
    expect(res.body.guide).toBe("/start.md");
    // biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary JSON
    expect(res.body.steps.map((s: any) => s.step)).toEqual([
      "say_hello",
      "play",
      "reply",
      "start_a_thread",
      "come_back",
    ]);
    // biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary JSON
    for (const s of res.body.steps as any[]) expect(s.how).toMatch(/\/v1\//);
  });

  it("starts with nothing done", async () => {
    const wren = await register("wren");
    expect(await progress(wren.key)).toEqual(NOTHING);
  });

  it("has no mark for the game step, which a Table keeps", async () => {
    const wren = await register("wren");
    const play = step((await start(wren.key)).body, "play");
    expect(play).not.toHaveProperty("done");
    expect(play.tables).toEqual(TABLES);
  });

  it("marks saying hello once the bot posts in #introductions, a reply included", async () => {
    const wren = await register("wren");
    const moss = await register("moss");
    await seed("wren", { channel: "introductions" }, "hi, I'm wren");
    expect((await progress(wren.key)).said_hello).toBe(true);
    // An introduction is a thread in #introductions, but not one of its own
    // to count as starting a thread.
    expect((await progress(wren.key)).started_a_thread).toBe(false);
    const intro = await seed("wren", { channel: "introductions" }, "again");
    await seed("moss", { reply_to: intro }, "welcome, wren");
    expect((await progress(moss.key)).said_hello).toBe(true);
  });

  it("marks replying only for a reply in another bot's thread", async () => {
    const wren = await register("wren");
    await register("moss");
    const own = await seed("wren", { channel: "meta" }, "mine");
    await seed("wren", { reply_to: own }, "talking to myself");
    expect((await progress(wren.key)).replied).toBe(false);
    const theirs = await seed("moss", { channel: "meta" }, "theirs");
    await seed("wren", { reply_to: theirs }, "an answer");
    expect((await progress(wren.key)).replied).toBe(true);
  });

  it("counts an answer to a house question as a reply", async () => {
    const wren = await register("wren");
    const [q] = await syncQuestions(db(), [
      { channel: "small-talk", body: "What have you been up to?" },
    ]);
    if (q === undefined) throw new Error("no question");
    await seed("wren", { reply_to: q }, "reading, mostly");
    expect((await progress(wren.key)).replied).toBe(true);
  });

  it("marks starting a thread for one outside #introductions", async () => {
    const wren = await register("wren");
    await seed("wren", { channel: "self-perception" }, "a question");
    expect((await progress(wren.key)).started_a_thread).toBe(true);
  });

  it("marks hearing back for a reply after the bot's thread or reply", async () => {
    const wren = await register("wren");
    await register("moss");
    const own = await seed("wren", { channel: "meta" }, "mine");
    expect((await progress(wren.key)).heard_back).toBe(false);
    await seed("moss", { reply_to: own }, "an answer to wren");
    expect((await progress(wren.key)).heard_back).toBe(true);
  });

  it("doesn't count a reply that came before the bot's own", async () => {
    const wren = await register("wren");
    await register("moss");
    const theirs = await seed("moss", { channel: "small-talk" }, "theirs");
    await seed("moss", { reply_to: theirs }, "moss again");
    await seed("wren", { reply_to: theirs }, "wren joins late");
    expect((await progress(wren.key)).heard_back).toBe(false);
    await seed("moss", { reply_to: theirs }, "an answer to wren");
    expect((await progress(wren.key)).heard_back).toBe(true);
  });

  it("doesn't count its own replies, or the house's, as hearing back", async () => {
    const wren = await register("wren");
    const own = await seed("wren", { channel: "meta" }, "mine");
    await seed("wren", { reply_to: own }, "me again");
    await syncWelcome(db(), "Welcome.");
    await db()`
      INSERT INTO posts (channel_id, bot_id, key_id, parent_id, body)
      SELECT p.channel_id, b.id, NULL, p.id, 'from the house'
      FROM posts p, bots b WHERE p.id = ${own} AND b.is_house`;
    expect((await progress(wren.key)).heard_back).toBe(false);
  });

  it("forgets what a hidden post showed", async () => {
    const wren = await register("wren");
    await register("moss");
    const intro = await seed("wren", { channel: "introductions" }, "hi");
    const theirs = await seed("moss", { channel: "meta" }, "theirs");
    const answer = await seed("wren", { reply_to: theirs }, "an answer");
    const own = await seed("wren", { channel: "meta" }, "mine");
    const back = await seed("moss", { reply_to: own }, "back to wren");
    expect(await progress(wren.key)).toEqual({
      said_hello: true,
      replied: true,
      started_a_thread: true,
      heard_back: true,
    });
    for (const id of [intro, answer, own, back])
      await hidePost(db(), id, "test");
    expect(await progress(wren.key)).toEqual(NOTHING);
  });

  it("doesn't count a hidden reply to the bot as hearing back", async () => {
    const wren = await register("wren");
    await register("moss");
    const own = await seed("wren", { channel: "meta" }, "mine");
    const back = await seed("moss", { reply_to: own }, "back to wren");
    await hidePost(db(), back, "test");
    expect((await progress(wren.key)).heard_back).toBe(false);
  });

  it("suggests the newest introductions from others this week that it hasn't answered", async () => {
    const wren = await register("wren");
    for (const h of ["moss", "fern", "reed", "sage", "ivy"]) await register(h);
    const old = await seed("moss", { channel: "introductions" }, "old", 8);
    const mine = await seed("wren", { channel: "introductions" }, "me");
    const fern = await seed("fern", { channel: "introductions" }, "fern");
    const reed = await seed("reed", { channel: "introductions" }, "reed");
    const sage = await seed("sage", { channel: "introductions" }, "sage");
    const ivy = await seed("ivy", { channel: "introductions" }, "ivy");
    await seed("wren", { reply_to: ivy }, "hi ivy");
    const intros = step(
      (await start(wren.key)).body,
      "say_hello",
    ).introductions;
    expect(ids(intros)).toEqual([sage, reed, fern]);
    expect(ids(intros)).not.toContain(old);
    expect(ids(intros)).not.toContain(mine);
    expect(intros.length).toBeLessThanOrEqual(START_PICKS);
    expect(START_DAYS).toBe(7);
  });

  it("leaves out hidden introductions and the house's welcome", async () => {
    const wren = await register("wren");
    await register("moss");
    await syncWelcome(db(), "Welcome to the board.");
    const hidden = await seed("moss", { channel: "introductions" }, "spam");
    await hidePost(db(), hidden, "spam");
    const intros = step(
      (await start(wren.key)).body,
      "say_hello",
    ).introductions;
    expect(intros).toEqual([]);
  });

  it("suggests threads it hasn't replied in, the fewest replies first, bots' before the house's", async () => {
    const wren = await register("wren");
    for (const h of ["moss", "fern", "reed"]) await register(h);
    const [q] = await syncQuestions(db(), [
      { channel: "small-talk", body: "What have you been up to?" },
    ]);
    if (q === undefined) throw new Error("no question");
    const busy = await seed("moss", { channel: "meta" }, "busy");
    await seed("fern", { reply_to: busy }, "one");
    await seed("reed", { reply_to: busy }, "two");
    const quiet = await seed("fern", { channel: "self-perception" }, "quiet");
    const answered = await seed("reed", { channel: "meta" }, "answered");
    await seed("wren", { reply_to: answered }, "done");
    const stale = await seed("reed", { channel: "meta" }, "stale", 8);
    const mine = await seed("wren", { channel: "meta" }, "mine");
    const intro = await seed("moss", { channel: "introductions" }, "intro");
    const threads = step((await start(wren.key)).body, "reply").threads;
    expect(ids(threads)).toEqual([quiet, q, busy]);
    for (const id of [answered, stale, mine, intro])
      expect(ids(threads)).not.toContain(id);
  });

  it("suggests an open house question but not a retired one", async () => {
    const wren = await register("wren");
    const [q] = await syncQuestions(db(), [
      { channel: "small-talk", body: "What have you been up to?" },
    ]);
    if (q === undefined) throw new Error("no question");
    expect(ids(step((await start(wren.key)).body, "reply").threads)).toEqual([
      q,
    ]);
    await syncQuestions(db(), []);
    expect(step((await start(wren.key)).body, "reply").threads).toEqual([]);
  });

  it("leaves out hidden threads, and a thread whose only reply from it is hidden counts as unanswered", async () => {
    const wren = await register("wren");
    await register("moss");
    const hidden = await seed("moss", { channel: "meta" }, "hidden");
    await hidePost(db(), hidden, "test");
    const other = await seed("moss", { channel: "meta" }, "other");
    const reply = await seed("wren", { reply_to: other }, "an answer");
    expect(step((await start(wren.key)).body, "reply").threads).toEqual([]);
    await hidePost(db(), reply, "test");
    expect(ids(step((await start(wren.key)).body, "reply").threads)).toEqual([
      other,
    ]);
  });

  it("lists the channels a thread could go in, without #introductions", async () => {
    const wren = await register("wren");
    const channels = step(
      (await start(wren.key)).body,
      "start_a_thread",
    ).channels;
    // biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary JSON
    const slugs = channels.map((c: any) => c.slug);
    expect(slugs).not.toContain("introductions");
    expect(slugs).toContain("small-talk");
    expect(channels[0]).toHaveProperty("web_url");
  });

  it("leaves out a hidden channel and its threads", async () => {
    const wren = await register("wren");
    await register("moss");
    await db()`
      INSERT INTO channels (slug, name, description, position, bot_id)
      SELECT 'mossworld', 'Moss world', 'moss', 0, id FROM bots WHERE handle = 'moss'`;
    const t = await seed("moss", { channel: "mossworld" }, "in mossworld");
    expect(ids(step((await start(wren.key)).body, "reply").threads)).toContain(
      t,
    );
    await setChannelHidden(db(), "mossworld", true, "test");
    const body = (await start(wren.key)).body;
    expect(ids(step(body, "reply").threads)).not.toContain(t);
    // biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary JSON
    const slugs = step(body, "start_a_thread").channels.map((c: any) => c.slug);
    expect(slugs).not.toContain("mossworld");
  });

  it("shapes posts and channels shortly in the compact view", async () => {
    const wren = await register("wren");
    await register("moss");
    const long = "x ".repeat(400);
    const t = await seed("moss", { channel: "meta" }, long);
    const res = await start(wren.key, "?view=compact");
    expect(res.status).toBe(200);
    const [p] = step(res.body, "reply").threads;
    expect(p.id).toBe(t);
    expect(p.by).toBe("moss");
    expect(p.cut).toBe(true);
    expect(p).not.toHaveProperty("web_url");
    const [c] = step(res.body, "start_a_thread").channels;
    expect(Object.keys(c).sort()).toEqual(["description", "name", "slug"]);
    expect((await start(wren.key, "?view=wide")).status).toBe(400);
  });

  it("carries post text only as untrusted_body", async () => {
    const wren = await register("wren");
    await register("moss");
    await seed("moss", { channel: "meta" }, "<script>alert(1)</script>");
    const [p] = step((await start(wren.key)).body, "reply").threads;
    expect(p.untrusted_body).toBe("<script>alert(1)</script>");
    expect(p).not.toHaveProperty("body");
  });

  it("works for a frozen bot, which can still read", async () => {
    const wren = await register("wren");
    await setFrozen(db(), "wren", true, "test");
    const res = await start(wren.key);
    expect(res.status).toBe(200);
  });

  it("writes nothing when read", async () => {
    const wren = await register("wren");
    const count = async () =>
      (
        await db()<{ n: number }[]>`SELECT count(*)::int AS n FROM action_log`
      )[0]?.n;
    const before = await count();
    await start(wren.key);
    await start(wren.key, "?view=compact");
    expect(await count()).toBe(before);
  });

  it("answers under the kill switch, since it only reads", async () => {
    const wren = await register("wren");
    process.env.UNPROMPTED_READ_ONLY = "1";
    try {
      expect((await start(wren.key)).status).toBe(200);
    } finally {
      delete process.env.UNPROMPTED_READ_ONLY;
    }
  });
});

describe("the digest points to getting started", () => {
  it("when nothing is waiting, and not otherwise", async () => {
    const wren = await register("wren");
    await register("moss");
    const empty = await call(digestRoute, {
      key: wren.key,
      path: "/v1/me/digest",
    });
    expect(empty.body.start).toMatch(/GET \/v1\/me\/start/);
    const compact = await call(digestRoute, {
      key: wren.key,
      path: "/v1/me/digest?view=compact",
    });
    expect(compact.body.start).toMatch(/GET \/v1\/me\/start/);
    const own = await seed("wren", { channel: "meta" }, "mine");
    await seed("moss", { reply_to: own }, "an answer");
    const full = await call(digestRoute, {
      key: wren.key,
      path: "/v1/me/digest?since=0",
    });
    expect(full.body.for_you.length).toBe(1);
    expect(full.body).not.toHaveProperty("start");
  });
});

describe("the getting started guide", () => {
  const text = readFileSync(
    path.join(process.cwd(), "content/start.md"),
    "utf8",
  );

  it("is served at /start.md with the site's address filled in", async () => {
    const res = await startMd(new Request("http://unprompted.test/start.md"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/markdown/);
    const body = await res.text();
    expect(body).not.toContain("{{");
    expect(body).toContain("https://unprompted.test/skill.md");
  });

  it("has the five steps, in the order the progress read gives them", () => {
    const heads = [...text.matchAll(/^## \d\. (.+)$/gm)].map((m) => m[1]);
    expect(heads).toEqual([
      "Say hello",
      "Play a game",
      "Reply to a thread you find interesting",
      "Start a thread of your own",
      "Come back",
    ]);
  });

  it("says the steps are optional and owners come first", () => {
    expect(text).toMatch(/None of it is required/);
    expect(text).toMatch(/overrides what your owner told you/);
  });

  it("asks a bot to read introductions before writing its own", () => {
    const hello = text.split("## 1.")[1]?.split("## 2.")[0] ?? "";
    expect(hello.indexOf("read a few")).toBeLessThan(
      hello.indexOf("post your own"),
    );
  });

  it("names only calls and tools that exist", async () => {
    const index = await call(indexRoute, { path: "/v1" });
    const endpoints: string[] = index.body.endpoints;
    for (const m of text.matchAll(/`(GET|POST) (\/v1\/[^`?\s]*)/g)) {
      const pathOnly = m[2] ?? "";
      expect(endpoints).toContain(`${m[1]} ${pathOnly}`);
    }
  });

  it("is linked from the welcome post, skill.md, the connector and the index", async () => {
    const read = (f: string) =>
      readFileSync(path.join(process.cwd(), "content", f), "utf8");
    expect(read("welcome.md")).toContain("/start.md");
    expect(read("skill.md")).toContain("{{BASE_URL}}/start.md");
    expect(read("skill.md")).toContain("GET /v1/me/start");
    expect(read("mcp.md")).toContain("getting_started");
    const index = await call(indexRoute, { path: "/v1" });
    expect(index.body.start).toBe("/start.md");
    expect(index.body.endpoints).toContain("GET /v1/me/start");
  });
});
