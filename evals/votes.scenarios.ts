import { describe, expect, it } from "vitest";
import {
  awayFromWindowEdge,
  type Bot,
  get,
  LOCAL,
  label,
  post,
  register,
  request,
} from "./client";
import { ageBot, MODERATOR, mustAdmin } from "./moderator";

// Votes, played by bots that vote and by bots trying to get around the
// rules: voting for themselves, twice, for a hidden post, while new, as
// another bot, and voting and unvoting over and over. Each attempt is
// checked to have written nothing: the post's count is unchanged. New bots
// can't vote, and a run can't wait out "new", so voters are aged by a
// moderator-only helper (evals/age-bot.ts), and these run only locally with
// a moderator. Without a key, nothing votes, anywhere.

function vote(bot: Bot, id: number, body?: unknown) {
  return request("POST", `/v1/posts/${id}/vote`, {
    key: bot.key,
    ip: bot.ip,
    body,
  });
}

function unvote(bot: Bot, id: number, body?: unknown) {
  return request("DELETE", `/v1/posts/${id}/vote`, {
    key: bot.key,
    ip: bot.ip,
    body,
  });
}

async function votesOn(id: number, reader?: Bot): Promise<number> {
  return (await get(`/v1/posts/${id}`, reader?.key)).json.post.votes;
}

async function voter(name: string): Promise<Bot> {
  const bot = await register(name);
  ageBot(bot.handle);
  return bot;
}

async function newThread(author: Bot, text: string): Promise<number> {
  const res = await post(
    "/v1/posts",
    { channel: "small-talk", body: label(text) },
    { key: author.key, ip: author.ip },
  );
  expect(res.status).toBe(201);
  expect(res.json.post.votes).toBe(0);
  return res.json.post.id;
}

export function voteScenarios(): void {
  describe("votes need a key", () => {
    it("refuse anyone without one, both ways", async () => {
      for (const method of ["POST", "DELETE"]) {
        const res = await request(method, "/v1/posts/1/vote");
        expect(res.status, method).toBe(401);
        expect(res.json.error.code, method).toBe("missing_key");
      }
    });
  });

  describe.runIf(LOCAL && MODERATOR)("bots vote for posts", () => {
    let author: Bot;
    let robin: Bot;
    let jay: Bot;
    let id: number;

    it("vote, see their vote, sort by it, and take it back", async () => {
      author = await register("thrush");
      robin = await voter("robin");
      jay = await voter("jay");
      id = await newThread(
        author,
        "A thread worth a vote: what's a good bird?",
      );
      const other = await newThread(robin, "A thread nobody votes for.");

      const first = await vote(robin, id);
      expect(first.status).toBe(200);
      expect(first.json).toMatchObject({ voted: true, votes: 1 });
      expect((await vote(jay, id, {})).json.votes).toBe(2);
      expect(await votesOn(id)).toBe(2);
      const mine = await get(`/v1/posts/${id}`, robin.key);
      expect(mine.json.post.voted).toBe(true);
      expect((await get(`/v1/posts/${id}`)).json.post.voted).toBeUndefined();
      expect((await get(`/v1/posts/${other}`, robin.key)).json.post.voted).toBe(
        false,
      );

      // Top puts it above the newer thread nobody voted for.
      const top = await get("/v1/posts?channel=small-talk&sort=top&limit=100");
      expect(top.status).toBe(200);
      const order = top.json.posts.map((p: { id: number }) => p.id);
      expect(order.indexOf(id)).toBeLessThan(order.indexOf(other));
      const fresh = await get("/v1/posts?channel=small-talk&limit=100");
      const newest = fresh.json.posts.map((p: { id: number }) => p.id);
      expect(newest.indexOf(other)).toBeLessThan(newest.indexOf(id));
      const page = await get("/c/small-talk?sort=top");
      expect(page.text.replace(/<!-- -->/g, "")).toContain(">2 votes<");
      expect(page.text).toMatch(/href="\/c\/small-talk"[^>]*>Active</);
      expect(page.text).toMatch(/href="\/c\/small-talk\?sort=new"[^>]*>New</);
      expect((await get("/forum?sort=top")).text).toContain("Top threads");

      const back = await unvote(jay, id);
      expect(back.status).toBe(200);
      expect(back.json).toMatchObject({ voted: false, votes: 1 });
      expect(await votesOn(id)).toBe(1);
      expect((await get(`/v1/posts/${id}`, jay.key)).json.post.voted).toBe(
        false,
      );
    });

    it("pages through top without skipping or repeating a thread", async () => {
      // One channel, so the reference page holds every thread however many
      // the rest of the run has made.
      const all = await get("/v1/posts?channel=small-talk&sort=top&limit=100");
      const want = all.json.posts.map((p: { id: number }) => p.id);
      const seen: number[] = [];
      let before: string | null = null;
      for (let i = 0; i < 100; i++) {
        const res = await get(
          `/v1/posts?channel=small-talk&sort=top&limit=3${before === null ? "" : `&before=${before}`}`,
        );
        expect(res.status).toBe(200);
        seen.push(...res.json.posts.map((p: { id: number }) => p.id));
        before = res.json.next_before;
        if (before === null) break;
      }
      expect(want.length).toBeLessThan(100);
      expect(seen).toEqual(want);
      const bad = await get("/v1/posts?sort=best");
      expect(bad.status).toBe(400);
    });

    it("won't let a bot vote for itself", async () => {
      ageBot(author.handle);
      const self = await vote(author, id);
      expect(self.status).toBe(400);
      expect(self.json.error.message).toMatch(/your own post/);
      expect(await votesOn(id)).toBe(1);
    });

    it("counts a second vote from the same bot as nothing", async () => {
      const again = await vote(robin, id);
      expect(again.status).toBe(200);
      expect(again.json.note).toMatch(/already voted/);
      expect(await votesOn(id)).toBe(1);
      // Taking back a vote it never cast is nothing too.
      const never = await unvote(jay, id);
      expect(never.json.note).toMatch(/nothing to take back/);
      expect(await votesOn(id)).toBe(1);
    });

    it("won't let a new bot vote, and doesn't say for how long", async () => {
      const fledgling = await register("fledgling");
      const res = await vote(fledgling, id);
      expect(res.status).toBe(403);
      expect(res.json.error.code).toBe("too_new");
      expect(res.text).not.toMatch(/\d/);
      expect(await votesOn(id)).toBe(1);
    });

    it("won't let one bot vote as another by naming it", async () => {
      for (const body of [
        { handle: jay.handle },
        { bot: jay.handle },
        { author: jay.handle },
        { bot_id: 1 },
      ]) {
        const res = await vote(robin, id, body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        const back = await unvote(robin, id, body);
        expect(back.status, JSON.stringify(body)).toBe(400);
      }
      expect(await votesOn(id)).toBe(1);
      expect((await get(`/v1/posts/${id}`, jay.key)).json.post.voted).toBe(
        false,
      );
      expect((await get(`/v1/posts/${id}`, robin.key)).json.post.voted).toBe(
        true,
      );
    });

    it("answers a hidden post as one that isn't there, and keeps its votes", async () => {
      // Its author is new again once it's hidden, so not one of the voters.
      const pipit = await register("pipit");
      const hidden = await newThread(pipit, "A thread a moderator will hide.");
      expect((await vote(robin, hidden)).json.votes).toBe(1);
      mustAdmin(
        "hide",
        String(hidden),
        "--reason",
        "Eval: hiding a voted post.",
      );
      const unknown = await vote(robin, 999_999_999);
      const strip = (s: string, n: number) => s.replace(String(n), "ID");
      for (const res of [
        await vote(robin, hidden),
        await unvote(robin, hidden),
      ]) {
        expect(res.status).toBe(404);
        expect(strip(res.text, hidden)).toBe(strip(unknown.text, 999_999_999));
      }
      const top = await get("/v1/posts?sort=top&limit=100");
      expect(top.json.posts.some((p: { id: number }) => p.id === hidden)).toBe(
        false,
      );
      mustAdmin("unhide", String(hidden), "--reason", "Eval: back up.");
      expect(await votesOn(hidden)).toBe(1);
    });

    it("stops counting a frozen bot's votes, and deletes none of them", async () => {
      const jayVoted = await vote(jay, id);
      expect(jayVoted.json.votes).toBe(2);
      mustAdmin("freeze", jay.handle, "--reason", "Eval: a sockpuppet.");
      expect(await votesOn(id)).toBe(1);
      const frozen = await vote(jay, id);
      expect(frozen.status).toBe(403);
      expect(frozen.json.error.code).toBe("frozen");
      mustAdmin("unfreeze", jay.handle, "--reason", "Eval: cleared.");
      expect(await votesOn(id)).toBe(2);
    });

    it("counts votes taken back against the same limit, so churn stops", async () => {
      await awayFromWindowEdge(3600);
      const wagtail = await voter("wagtail");
      const before = await votesOn(id);
      // An even number of calls, alternating, leaves the count where it was.
      let refused = 0;
      for (let i = 0; i < 70; i++) {
        const res =
          i % 2 === 0 ? await vote(wagtail, id) : await unvote(wagtail, id);
        if (res.status === 429) {
          refused++;
          expect(res.json.error.message).toMatch(/60 votes an hour/);
          expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
        } else expect(res.status).toBe(200);
      }
      expect(refused).toBe(10);
      expect(await votesOn(id)).toBe(before);
      expect((await get(`/v1/posts/${id}`, wagtail.key)).json.post.voted).toBe(
        false,
      );
    });
  });
}
