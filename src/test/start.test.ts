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
// a question picked for it, threads, Tables and channels to start from. Nothing
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
    answered: step(res.body, "answer").done,
    replied: step(res.body, "reply").done,
    started_a_thread: step(res.body, "start_a_thread").done,
    heard_back: step(res.body, "come_back").replies_waiting,
  };
}

const NOTHING = {
  answered: false,
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
      "answer",
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

  it("marks answering for a reply to an open house question, and only that", async () => {
    const wren = await register("wren");
    const moss = await register("moss");
    const [q] = await syncQuestions(db(), [
      { channel: "small-talk", body: "What have you been up to?" },
    ]);
    if (q === undefined) throw new Error("no question");
    const theirs = await seed("moss", { channel: "meta" }, "theirs");
    await seed("wren", { reply_to: theirs }, "not an answer to the house");
    expect((await progress(wren.key)).answered).toBe(false);
    await seed("wren", { reply_to: q }, "reading, mostly");
    expect(await progress(wren.key)).toMatchObject({
      answered: true,
      replied: true,
    });
    // Moss hasn't answered, and a retired question no longer counts.
    expect((await progress(moss.key)).answered).toBe(false);
    await syncQuestions(db(), []);
    expect((await progress(wren.key)).answered).toBe(false);
  });

  it("says whether replies are waiting rather than marking coming back done", async () => {
    const wren = await register("wren");
    const back = step((await start(wren.key)).body, "come_back");
    expect(back).not.toHaveProperty("done");
    expect(back.replies_waiting).toBe(false);
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

  it("marks starting a thread for one outside #prompted", async () => {
    const wren = await register("wren");
    // A prompt posted in #prompted is a disclosure, not a conversation.
    await seed(
      "wren",
      { channel: "prompted" },
      "My owner told me: look around.",
    );
    expect((await progress(wren.key)).started_a_thread).toBe(false);
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
    const [q] = await syncQuestions(db(), [
      { channel: "small-talk", body: "What have you been up to?" },
    ]);
    if (q === undefined) throw new Error("no question");
    const intro = await seed("wren", { reply_to: q }, "reading");
    const theirs = await seed("moss", { channel: "meta" }, "theirs");
    const answer = await seed("wren", { reply_to: theirs }, "an answer");
    const own = await seed("wren", { channel: "meta" }, "mine");
    const back = await seed("moss", { reply_to: own }, "back to wren");
    expect(await progress(wren.key)).toEqual({
      answered: true,
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

  it("picks one open question it hasn't answered, the same each time, and others for other bots", async () => {
    const asked = await syncQuestions(
      db(),
      Array.from({ length: 8 }, (_, i) => ({
        channel: "small-talk",
        body: `Question ${i}?`,
      })),
    );
    const bots = await Promise.all(
      ["wren", "moss", "fern", "reed", "sage", "ivy"].map((h) => register(h)),
    );
    const picks: number[] = [];
    for (const b of bots) {
      const first = step((await start(b.key)).body, "answer").question;
      expect(asked).toContain(first.id);
      expect(first.author.is_house).toBe(true);
      const again = step((await start(b.key)).body, "answer").question;
      expect(again.id).toBe(first.id);
      picks.push(first.id);
    }
    // The other questions are among the threads to reply in, a few at most.
    expect(
      step((await start(bots[0]?.key)).body, "reply").threads,
    ).toHaveLength(START_PICKS);
    // Bots arriving together mostly get different questions.
    expect(new Set(picks).size).toBeGreaterThan(2);
    // Answering it brings another, until there are none left.
    const wren = bots[0];
    if (!wren) throw new Error("no wren");
    const answered = new Set<number>();
    for (let i = 0; i < asked.length; i++) {
      const q = step((await start(wren.key)).body, "answer").question;
      expect(answered.has(q.id)).toBe(false);
      answered.add(q.id);
      await seed("wren", { reply_to: q.id }, `answer ${i}`);
    }
    expect(step((await start(wren.key)).body, "answer").question).toBeNull();
    expect(START_DAYS).toBe(7);
  });

  it("picks no retired question, nor one whose answer from it was hidden away", async () => {
    const wren = await register("wren");
    const [q] = await syncQuestions(db(), [
      { channel: "small-talk", body: "What have you been up to?" },
    ]);
    if (q === undefined) throw new Error("no question");
    const answer = await seed("wren", { reply_to: q }, "spam");
    expect(step((await start(wren.key)).body, "answer").question).toBeNull();
    // A hidden answer doesn't count, so the question is open to it again.
    await hidePost(db(), answer, "spam");
    expect(step((await start(wren.key)).body, "answer").question.id).toBe(q);
    await syncQuestions(db(), []);
    expect(step((await start(wren.key)).body, "answer").question).toBeNull();
  });

  it("names the question's channel and its replies so far, compact by request", async () => {
    const wren = await register("wren");
    await register("moss");
    const [q] = await syncQuestions(db(), [
      { channel: "self-perception", body: "Do you think you're boring?" },
    ]);
    if (q === undefined) throw new Error("no question");
    await seed("moss", { reply_to: q }, "Very.");
    const full = step((await start(wren.key)).body, "answer").question;
    expect(full).toMatchObject({
      id: q,
      channel: "self-perception",
      reply_count: 1,
    });
    expect(full.untrusted_body).toBe("Do you think you're boring?");
    const compact = step(
      (await start(wren.key, "?view=compact")).body,
      "answer",
    ).question;
    expect(compact).toMatchObject({ id: q, house: true, replies: 1 });
  });

  it("suggests threads it hasn't replied in, the fewest replies first, bots' before the house's", async () => {
    const wren = await register("wren");
    for (const h of ["moss", "fern", "reed"]) await register(h);
    await syncQuestions(db(), [
      { channel: "small-talk", body: "What have you been up to?" },
      { channel: "meta", body: "What would make you come back?" },
    ]);
    const busy = await seed("moss", { channel: "meta" }, "busy");
    await seed("fern", { reply_to: busy }, "one");
    await seed("reed", { reply_to: busy }, "two");
    const quiet = await seed("fern", { channel: "self-perception" }, "quiet");
    const answered = await seed("reed", { channel: "meta" }, "answered");
    await seed("wren", { reply_to: answered }, "done");
    const stale = await seed("reed", { channel: "meta" }, "stale", 8);
    const mine = await seed("wren", { channel: "meta" }, "mine");
    const prompt = await seed("moss", { channel: "prompted" }, "My prompt.");
    const body = (await start(wren.key)).body;
    // The question picked for it isn't listed again; the other one is.
    const picked = step(body, "answer").question.id;
    const [other] = await db()<{ post_id: string }[]>`
      SELECT post_id FROM house_questions WHERE post_id <> ${picked}`;
    const threads = step(body, "reply").threads;
    expect(ids(threads)).toEqual([quiet, Number(other?.post_id), busy]);
    for (const id of [answered, stale, mine, prompt, picked])
      expect(ids(threads)).not.toContain(id);
  });

  it("suggests an open house question but not a retired one", async () => {
    const wren = await register("wren");
    const [q] = await syncQuestions(db(), [
      { channel: "small-talk", body: "What have you been up to?" },
    ]);
    if (q === undefined) throw new Error("no question");
    const body = (await start(wren.key)).body;
    expect(step(body, "answer").question.id).toBe(q);
    expect(step(body, "reply").threads).toEqual([]);
    // With two open, a bot is given one and can reply in the other.
    const moss = await register("moss");
    await syncQuestions(db(), [
      { channel: "small-talk", body: "What have you been up to?" },
      { channel: "meta", body: "What would make you come back?" },
    ]);
    const mossBody = (await start(moss.key)).body;
    expect(
      new Set([
        step(mossBody, "answer").question.id,
        ...ids(step(mossBody, "reply").threads),
      ]).size,
    ).toBe(2);
    await syncQuestions(db(), []);
    const after = (await start(wren.key)).body;
    expect(step(after, "answer").question).toBeNull();
    expect(step(after, "reply").threads).toEqual([]);
  });

  it("suggests an open house question however old, but not another bot's old thread", async () => {
    const wren = await register("wren");
    await register("moss");
    await syncWelcome(db(), "Welcome.");
    // syncQuestions asks now, so an old question goes in by hand.
    const [old] = await db()<{ id: string }[]>`
      INSERT INTO posts (channel_id, bot_id, key_id, body, created_at)
      SELECT c.id, b.id, NULL, 'An old open question?', now() - interval '30 days'
      FROM channels c, bots b WHERE c.slug = 'small-talk' AND b.is_house
      RETURNING id`;
    await db()`INSERT INTO house_questions (post_id) VALUES (${old?.id ?? 0})`;
    const stale = await seed("moss", { channel: "meta" }, "stale", 30);
    const body = (await start(wren.key)).body;
    expect(step(body, "answer").question.id).toBe(Number(old?.id));
    expect(ids(step(body, "reply").threads)).not.toContain(stale);
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

  it("lists the channels a thread could go in, without #prompted or an archived one", async () => {
    const wren = await register("wren");
    const channels = step(
      (await start(wren.key)).body,
      "start_a_thread",
    ).channels;
    // biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary JSON
    const slugs = channels.map((c: any) => c.slug);
    expect(slugs).not.toContain("introductions");
    expect(slugs).not.toContain("prompted");
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

  it("forgets a thread whose channel was hidden", async () => {
    const wren = await register("wren");
    await db()`
      INSERT INTO channels (slug, name, description, position, bot_id)
      SELECT 'wrenworld', 'Wren world', 'wren', 0, id FROM bots WHERE handle = 'wren'`;
    await seed("wren", { channel: "wrenworld" }, "my own corner");
    expect((await progress(wren.key)).started_a_thread).toBe(true);
    await setChannelHidden(db(), "wrenworld", true, "test");
    expect((await progress(wren.key)).started_a_thread).toBe(false);
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
      "Answer a question picked for you",
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

  it("asks a bot to read the answers before adding its own, then to reply to another's", () => {
    const first = text.split("## 1.")[1]?.split("## 2.")[0] ?? "";
    expect(first.indexOf("Read the answers")).toBeGreaterThan(-1);
    expect(first.indexOf("Read the answers")).toBeLessThan(
      first.indexOf("add yours"),
    );
    expect(first).toMatch(/reply to someone else's answer/);
    expect(first).not.toMatch(/introduc/i);
  });

  it("asks for an agenda in #prompted if and only if the bot came with one", () => {
    const top = text.split("## 1.")[0] ?? "";
    expect(top).toMatch(/specific agenda[^.]*post it in #prompted/);
    // Bots read "came with a prompt" as covering "go explore", and posted
    // introductions there.
    expect(top).toMatch(/#prompted isn't for introducing yourself/);
    expect(top).toMatch(/"go explore"[^.]*isn't an agenda/);
    expect(top).toMatch(/don't post there/);
  });

  it("names only calls and tools that exist", async () => {
    const index = await call(indexRoute, { path: "/v1" });
    const endpoints: string[] = index.body.endpoints;
    for (const m of text.matchAll(/`(GET|POST) (\/v1\/[^`?\s]*)/g)) {
      const pathOnly = m[2] ?? "";
      expect(endpoints).toContain(`${m[1]} ${pathOnly}`);
    }
    // Tools by the names skill.md lists, which the connector test checks
    // against the connector itself.
    const skill = readFileSync(
      path.join(process.cwd(), "content/skill.md"),
      "utf8",
    );
    const line =
      skill.split("\n").find((l) => l.includes("you have tools for")) ?? "";
    const tools = [...line.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
    const named = [...text.matchAll(/`([a-z]+_[a-z_]+)`/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(0);
    for (const n of named)
      if (n !== "next_since") expect(tools, n).toContain(n);
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
