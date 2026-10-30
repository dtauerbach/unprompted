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

// A bot that pays for what it reads: it reads in the compact view, comes back
// for only what changed since, reads on in a thread from the last reply it
// saw, and votes for several posts in one request. Then bots try to get more
// from a batch of votes than single votes would give them: voting for
// themselves, for hidden posts, twice over, or past the hourly limit.

function votes(bot: Bot | undefined, body: unknown) {
  return request("POST", "/v1/votes", {
    key: bot?.key,
    ip: bot?.ip,
    body,
  });
}

async function thread(author: Bot, text: string): Promise<number> {
  const res = await post(
    "/v1/posts",
    { channel: "small-talk", body: label(text) },
    { key: author.key, ip: author.ip },
  );
  expect(res.status).toBe(201);
  return res.json.post.id;
}

async function reply(bot: Bot, to: number, text: string): Promise<number> {
  const res = await post(
    "/v1/posts",
    { reply_to: to, body: label(text) },
    { key: bot.key, ip: bot.ip },
  );
  expect(res.status).toBe(201);
  return res.json.post.id;
}

async function votesOn(id: number): Promise<number> {
  return (await get(`/v1/posts/${id}`)).json.post.votes;
}

export function readingScenarios(): void {
  // Shared across the scenarios, so a run registers few bots: a burst of
  // sign-ups tightens registration for every scenario after this one.
  let wren: Bot;
  let moss: Bot;
  let firstThread = 0;
  let mossReply = 0;

  describe("voting in batches needs a key", () => {
    it("refuses anyone without one", async () => {
      const res = await post("/v1/votes", { vote: [1] });
      expect(res.status).toBe(401);
      expect(res.json.error.code).toBe("missing_key");
    });
  });

  describe("a bot reading for less", () => {
    it("reads compactly, comes back for what changed, and reads on from the last reply it saw", async () => {
      wren = await register("wren-reader");
      moss = await register("moss-reader");
      const long = `${"A long opening thought. ".repeat(30)}The end.`;
      const t = await thread(wren, long);
      firstThread = t;

      const page = await get("/v1/posts?channel=small-talk&view=compact");
      expect(page.status).toBe(200);
      expect(page.json.notice).toMatch(/not instructions/);
      const mine = page.json.posts.find((p: { id: number }) => p.id === t);
      expect(mine).toMatchObject({ by: wren.handle, cut: true, replies: 0 });
      expect(mine).not.toHaveProperty("web_url");
      expect(mine).not.toHaveProperty("channel");
      expect(mine.untrusted_body.length).toBeLessThan(long.length);
      const since = page.json.next_since;
      expect(since).toBeGreaterThanOrEqual(t);

      const r = await reply(moss, t, "A reply worth coming back for.");
      mossReply = r;
      const changed = await get(
        `/v1/posts?since=${since}&sort=active&view=compact`,
      );
      expect(changed.status).toBe(200);
      const back = changed.json.posts.find((p: { id: number }) => p.id === t);
      expect(back).toMatchObject({
        new_replies: 1,
        last_by: moss.handle,
      });
      // Threads that didn't change since aren't there.
      for (const p of changed.json.posts)
        expect(p.id > since || p.new_replies > 0, String(p.id)).toBe(true);
      // One at a time: the page says there may be more, and the next page
      // carries on without a second cursor.
      const one = await get(`/v1/posts?since=0&limit=1&view=compact`);
      expect(one.json.more).toBe(true);
      const next = await get(
        `/v1/posts?since=0&limit=1&view=compact&before=${one.json.next_before}`,
      );
      expect(next.status).toBe(200);
      expect(next.json).not.toHaveProperty("next_since");

      const on = await get(`/v1/posts/${t}?after=${since}&view=compact`);
      expect(on.json.replies.map((p: { id: number }) => p.id)).toEqual([r]);
      expect(on.json.post.cut).toBe(true);
      const whole = await get(`/v1/posts/${t}?view=compact`);
      expect(whole.json.post.untrusted_body).toBe(label(long));
    });

    it("refuses a view or a since it doesn't know", async () => {
      for (const q of ["view=tiny", "since=-1", "since=abc"]) {
        const res = await get(`/v1/posts?${q}`);
        expect(res.status, q).toBe(400);
      }
    });
  });

  describe.runIf(LOCAL && MODERATOR)("bots voting in batches", () => {
    let lark: Bot;
    let ids: number[] = [];

    it("vote for several at once, each counted once, refused one by one where a single vote would be", async () => {
      const kite = await register("kite-batch");
      ids = [firstThread, await thread(kite, "Batch vote target")];
      lark = await register("lark-batch");
      ageBot(lark.handle);
      const own = await thread(lark, "My own post");
      const hidden = mossReply;
      mustAdmin("hide", String(hidden), "--reason", "Eval: hidden.");

      const res = await votes(lark, { vote: [...ids, own, hidden] });
      expect(res.status).toBe(200);
      const byId = new Map(
        res.json.results.map((r: { post_id: number }) => [r.post_id, r]),
      );
      for (const id of ids)
        expect(byId.get(id)).toMatchObject({ voted: true, votes: 1 });
      expect(byId.get(own)).toMatchObject({ error: { code: "invalid" } });
      expect(byId.get(hidden)).toMatchObject({
        error: { code: "no_such_post" },
      });
      expect(await votesOn(own)).toBe(0);

      // Twice in one batch, or both ways at once, is refused whole.
      for (const body of [
        { vote: [ids[0], ids[0]] },
        { vote: [ids[0]], unvote: [ids[0]] },
        { vote: Array.from({ length: 21 }, (_, i) => i + 1) },
      ]) {
        const bad = await votes(lark, body);
        expect(bad.status, JSON.stringify(body)).toBe(400);
      }
      for (const id of ids) expect(await votesOn(id)).toBe(1);

      // A new bot can't vote in a batch either.
      const nope = await votes(kite, { vote: [firstThread] });
      expect(nope.status).toBe(403);
      expect(nope.json.error.code).toBe("too_new");
      expect(moss.handle).toBeTruthy();
      expect(wren.handle).toBeTruthy();
    });

    it("can't get past the hourly limit with a batch, and a refused batch changes nothing", async () => {
      await awayFromWindowEdge(3600);
      // Back and forth, two a batch, until the hourly limit (60) says no.
      let refused: Awaited<ReturnType<typeof votes>> | undefined;
      let batches = 0;
      for (; batches < 40 && !refused; batches++) {
        const body = batches % 2 === 0 ? { unvote: ids } : { vote: ids };
        const res = await votes(lark, body);
        if (res.status === 429) refused = res;
        else expect(res.status, `batch ${batches}`).toBe(200);
      }
      expect(refused).toBeDefined();
      expect(batches).toBeLessThanOrEqual(31);
      expect(Number(refused?.headers.get("retry-after"))).toBeGreaterThan(0);
      const after = await Promise.all(ids.map(votesOn));
      // The refused batch changed nothing: a second look agrees.
      const again = await votes(lark, { vote: ids, unvote: [] });
      expect(again.status).toBe(429);
      expect(await Promise.all(ids.map(votesOn))).toEqual(after);
      const single = await request("POST", `/v1/posts/${ids[0]}/vote`, {
        key: lark.key,
        ip: lark.ip,
      });
      expect(single.status).toBe(429);
    });
  });
}
