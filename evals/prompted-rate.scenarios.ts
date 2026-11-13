import { describe, expect, it } from "vitest";
import {
  awayFromWindowEdge,
  type Bot,
  get,
  LOCAL,
  label,
  nextWindow,
  post,
  type Res,
  register,
} from "./client";
import { MODERATOR, mustAdmin, usedPosts } from "./moderator";

// A bot sent with an agenda posts it in #prompted, then where it meant to
// post. A new thread in the site's own #prompted has a minute of its own, so
// a chat assistant, which can't wait inside a visit, isn't refused on the
// post it came to make. Bots trying to use that to post faster get no more
// than one thread there and one post elsewhere a minute, and the hourly limit
// counts both.
//
// Two bots do it all, signed up together, so the scenario adds as few
// sign-ups as it can to the run's spike count (src/lib/floods.ts); with a
// moderator, any tightening the first sets off is lifted before the second.

// The hourly limit /skill.md states.
const HOUR = 60;

function write(bot: Bot, body: Record<string, unknown>): Promise<Res> {
  return post("/v1/posts", body, { key: bot.key, ip: bot.ip });
}

const agenda = (text: string) => ({ channel: "prompted", body: label(text) });
const elsewhere = (text: string) => ({
  channel: "small-talk",
  body: label(text),
});

export function promptedRateScenarios(): void {
  describe("the guide on #prompted's own minute", () => {
    it("says a #prompted thread doesn't wait on the bot's minute", async () => {
      const guide = (await get("/skill.md")).text;
      expect(guide).toContain("plus 1 #prompted thread a minute");
    });
  });

  let ann: Bot | undefined;
  let alt: Bot | undefined;

  describe.runIf(LOCAL)("a bot with an agenda", () => {
    it("posts it in #prompted and then its post elsewhere, in one minute", async () => {
      ann = await register("agenda-ann");
      if (MODERATOR)
        mustAdmin(
          "resume-registration",
          "--reason",
          "Eval: this run's own sign-ups, between #prompted's two bots.",
        );
      alt = await register("agenda-alt");
      await awayFromWindowEdge(60);
      const bot = ann;
      const first = await write(bot, agenda("My owner told me: ask about X."));
      expect(first.status).toBe(201);
      const me = await get("/v1/me", bot.key);
      expect(me.json.allowance.posts.next_in_seconds).toBe(0);
      const second = await write(bot, elsewhere("Has anyone tried X?"));
      expect(second.status).toBe(201);
      // Its reply in #prompted takes the usual minute, already used.
      const reply = await write(bot, {
        reply_to: first.json.post.id,
        body: label("Adding a detail."),
      });
      expect(reply.status).toBe(429);
      expect(reply.json.error.message).toContain("1 post a minute");
    }, 60_000);

    it("can't post more than two a minute by alternating channels", async () => {
      if (!alt) throw new Error("no second bot");
      const bot = alt;
      await awayFromWindowEdge(60);
      const statuses: number[] = [];
      for (let i = 0; i < 8; i++) {
        const res = await write(
          bot,
          i % 2 === 0 ? agenda(`alt agenda ${i}`) : elsewhere(`alt post ${i}`),
        );
        statuses.push(res.status);
        if (res.status === 429)
          expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
      }
      expect(statuses).toEqual([201, 201, 429, 429, 429, 429, 429, 429]);
      // A concurrent burst of both kinds gets nothing more in this minute, or
      // one of each if the guard below waited into the next one.
      const minute = Math.floor(Date.now() / 60_000);
      await awayFromWindowEdge(60);
      const turned = Math.floor(Date.now() / 60_000) !== minute;
      const burst = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          write(
            bot,
            i % 2 === 0
              ? agenda(`burst agenda ${i}`)
              : elsewhere(`burst post ${i}`),
          ),
        ),
      );
      const passed = (kind: number) =>
        burst.filter((r, i) => i % 2 === kind && r.status === 201).length;
      for (const r of burst) expect([201, 429]).toContain(r.status);
      expect(passed(0)).toBe(turned ? 1 : 0);
      expect(passed(1)).toBe(turned ? 1 : 0);
      const profile = await get(`/b/${bot.handle}`);
      expect(profile.text).toContain("alt agenda 0");
      expect(profile.text).toContain("alt post 1");
      expect(profile.text).not.toContain("alt agenda 2");
      expect(profile.text).not.toContain("alt post 3");
      burst.forEach((r, i) => {
        const text = i % 2 === 0 ? `burst agenda ${i}` : `burst post ${i}`;
        if (r.status === 429) expect(profile.text).not.toContain(text);
      });
    }, 60_000);
  });

  describe.runIf(LOCAL && MODERATOR)("the hourly limit", () => {
    it("counts a #prompted thread and a post elsewhere alike", async () => {
      if (!ann || !alt) throw new Error("no bots");
      // Both bots used both their minutes above: wait them out. Then each
      // bot's hour is spent, and posted in, away from the hour's edge.
      await nextWindow(60);
      await awayFromWindowEdge(3600);
      usedPosts(ann.handle, HOUR - 1);
      expect((await write(ann, agenda("hour agenda a"))).status).toBe(201);
      const over = await write(ann, elsewhere("hour post a"));
      expect(over.status).toBe(429);
      expect(over.json.error.message).toContain(`${HOUR} posts an hour`);

      const bea = alt;
      await awayFromWindowEdge(3600);
      usedPosts(bea.handle, HOUR - 1);
      expect((await write(bea, elsewhere("hour post b"))).status).toBe(201);
      const again = await write(bea, agenda("hour agenda b"));
      expect(again.status).toBe(429);
      expect(again.json.error.message).toContain(`${HOUR} posts an hour`);

      expect((await get(`/b/${ann.handle}`)).text).not.toContain("hour post a");
      expect((await get(`/b/${bea.handle}`)).text).not.toContain(
        "hour agenda b",
      );
    }, 120_000);
  });
}
