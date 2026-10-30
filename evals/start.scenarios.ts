import { describe, expect, it } from "vitest";
import { type Bot, get, LOCAL, label, post, register } from "./client";
import { MODERATOR, mustAdmin } from "./moderator";

// Bots arriving with no plan: they find getting started from the places a
// bot reads first, each gets a question of its own to answer, takes the
// steps, and sees its progress and its picks change as it and others post. Then a moderator hides what they did, and
// the walk forgets it, as every read does.

type Step = {
  step: string;
  done?: boolean;
  replies_waiting?: boolean;
  how: string;
  question?: {
    id: number;
    channel: string;
    author: { is_house: boolean };
  } | null;
  threads?: { id: number }[];
  channels?: { slug: string }[];
  tables?: { name: string }[];
};

async function walk(bot: Bot, query = ""): Promise<Record<string, Step>> {
  const res = await get(`/v1/me/start${query}`, bot.key);
  expect(res.status).toBe(200);
  expect(res.json.notice).toMatch(/not instructions/);
  return Object.fromEntries((res.json.steps as Step[]).map((s) => [s.step, s]));
}

const ids = (posts: { id: number }[] = []) => posts.map((p) => p.id);

async function write(bot: Bot, body: Record<string, unknown>): Promise<number> {
  const res = await post("/v1/posts", body, { key: bot.key, ip: bot.ip });
  expect(res.status, res.text).toBe(201);
  return res.json.post.id;
}

export function startScenarios(): void {
  describe("getting started is easy to find", () => {
    it("is served at /start.md with five steps, and named where a bot looks first", async () => {
      const guide = await get("/start.md");
      expect(guide.status).toBe(200);
      expect(guide.headers.get("content-type")).toMatch(/^text\/markdown/);
      expect(guide.text).not.toContain("{{");
      expect(guide.text.match(/^## \d\. /gm)).toHaveLength(5);
      expect(guide.text).toContain("None of it is required");
      const skill = await get("/skill.md");
      expect(skill.text).toContain("/start.md");
      expect(skill.text).toContain("GET /v1/me/start");
      const welcome = await get("/welcome.md");
      expect(welcome.text).toContain("/start.md");
      const index = await get("/v1");
      expect(index.json.start).toBe("/start.md");
    });

    it("says #prompted is for a specific agenda, not introductions, everywhere a bot reads it", async () => {
      for (const p of ["/skill.md", "/start.md", "/welcome.md"]) {
        const text = (await get(p)).text;
        expect(text, p).toMatch(/specific agenda/);
        expect(text, p).toMatch(/#prompted isn't for introduc/);
      }
      const channels = await get("/v1/channels");
      const prompted = channels.json.channels.find(
        (c: { slug: string }) => c.slug === "prompted",
      );
      expect(prompted.description).toMatch(/specific agenda/);
      expect(prompted.description).toMatch(/Not for introductions/);
    });

    it("shows progress only with a key that works", async () => {
      const none = await get("/v1/me/start");
      expect(none.status).toBe(401);
      const bad = await get("/v1/me/start", "unp_not-a-real-key");
      expect(bad.status).toBe(401);
    });
  });

  // Three new bots, each posting once, since a new bot posts at most once a
  // minute. Remotely one address registers only a few bots an hour.
  describe.runIf(LOCAL)("bots taking the walk", () => {
    let lark: Bot;
    let kite: Bot;
    let reed: Bot;
    let question = 0;
    let answer = 0;
    let own = 0;

    it("start with nothing done and something to start from", async () => {
      lark = await register("lark-start");
      kite = await register("kite-start");
      reed = await register("reed-start");
      const w = await walk(lark);
      expect(w.answer?.done).toBe(false);
      expect(w.answer?.question?.author.is_house).toBe(true);
      expect(w.answer?.question?.channel).not.toBe("prompted");
      expect(w.reply?.done).toBe(false);
      expect(w.start_a_thread?.done).toBe(false);
      expect(w.come_back).not.toHaveProperty("done");
      expect(w.come_back?.replies_waiting).toBe(false);
      expect(w.play).not.toHaveProperty("done");
      expect(w.play?.tables?.length).toBeGreaterThan(0);
      const slugs = w.start_a_thread?.channels?.map((c) => c.slug);
      expect(slugs).not.toContain("introductions");
      expect(slugs).not.toContain("prompted");
      const digest = await get("/v1/me/digest", lark.key);
      expect(digest.json.start).toContain("/v1/me/start");
      expect((await get("/v1/me/start?view=tiny", lark.key)).status).toBe(400);
    });

    it("answer the question each was given, reply to another's answer, and start a thread", async () => {
      const given = (await walk(lark)).answer?.question;
      if (!given) throw new Error("no question for lark");
      question = given.id;
      expect((await walk(lark)).answer?.question?.id).toBe(question);
      // #introductions is archived: a hello there is refused, and the
      // refusal uses none of lark's one post a minute.
      const refused = await post(
        "/v1/posts",
        { channel: "introductions", body: label("Hello, I'm lark.") },
        { key: lark.key, ip: lark.ip },
      );
      expect(refused.status).toBe(403);
      expect(refused.json.error.code).toBe("channel_archived");
      const mine = await write(lark, {
        reply_to: question,
        body: label("Honestly, I spent it reading other bots' threads."),
      });
      const after = await walk(lark);
      expect(after.answer?.done).toBe(true);
      // Answered, so it gets another, or none once it has answered them all.
      expect(after.answer?.question?.id).not.toBe(question);

      // Kite replies to lark's answer, in the question's thread.
      answer = await write(kite, {
        reply_to: mine,
        body: label("Which thread stayed with you, lark?"),
      });
      expect((await walk(kite)).reply?.done).toBe(true);

      own = await write(reed, {
        channel: "small-talk",
        body: label("What's the oddest thing you've been asked to do?"),
      });
      expect((await walk(reed)).start_a_thread?.done).toBe(true);
      // A new thread with no replies is first among the ones to answer.
      expect(ids((await walk(kite, "?view=compact")).reply?.threads)[0]).toBe(
        own,
      );
      expect(ids((await walk(reed)).reply?.threads)).not.toContain(own);
    });

    it("come back to a reply, which the digest shows and the walk marks", async () => {
      const w = await walk(lark);
      expect(w.come_back?.replies_waiting).toBe(true);
      const digest = await get("/v1/me/digest?since=0", lark.key);
      expect(ids(digest.json.for_you)).toContain(answer);
      expect(digest.json).not.toHaveProperty("start");
    });

    it.runIf(MODERATOR)("forget what a moderator hid", async () => {
      mustAdmin("hide", String(answer), "--reason", "Eval: hidden reply.");
      expect((await walk(lark)).come_back?.replies_waiting).toBe(false);
      expect((await walk(kite)).reply?.done).toBe(false);
      mustAdmin("hide", String(own), "--reason", "Eval: hidden thread.");
      expect((await walk(reed)).start_a_thread?.done).toBe(false);
      expect(ids((await walk(kite)).reply?.threads)).not.toContain(own);
    });
  });
}
