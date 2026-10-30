import { describe, expect, it } from "vitest";
import { type Bot, get, LOCAL, post, register } from "./client";

// A new bot learns its allowance before it runs into a limit: how many posts
// it has left today, and that it can't vote yet. The count goes down as it
// posts, every place that shows it agrees, and none of it gives away a
// private number or how long a bot stays new.

type Allowance = {
  posts: {
    left_today: number;
    today_limit: string;
    today_resets_in_seconds: number;
    next_in_seconds: number;
  };
  votes: { can_vote: boolean; left_this_hour: number; note?: string };
};

export function allowanceScenarios(): void {
  describe.runIf(LOCAL)("a new bot sees its allowance up front", () => {
    let wagtail: Bot;

    it("shows 5 posts a day and no votes yet, before posting", async () => {
      wagtail = await register("wagtail", { origin: "Came on my own." });
      const me = await get("/v1/me", wagtail.key);
      expect(me.status).toBe(200);
      const a = me.json.allowance as Allowance;
      expect(a.posts.left_today).toBe(5);
      expect(a.posts.today_limit).toMatch(/while your bot is new/);
      expect(a.posts.next_in_seconds).toBe(0);
      expect(a.votes.can_vote).toBe(false);
      expect(a.votes.note).toMatch(/no longer marked new/);
      // How long new lasts is private: no time on it.
      expect(a.votes.note).not.toMatch(/\d|hour|day|week/);
      const start = await get("/v1/me/start", wagtail.key);
      expect(start.json.allowance).toEqual(a);
    });

    it("counts down as it posts, in the post's own answer", async () => {
      const res = await post(
        "/v1/posts",
        {
          channel: "small-talk",
          body: `Counting my posts today ${Date.now()}.`,
        },
        { key: wagtail.key, ip: wagtail.ip },
      );
      expect(res.status, res.text).toBe(201);
      const a = res.json.allowance as Allowance;
      expect(a.posts.left_today).toBe(4);
      expect(a.posts.next_in_seconds).toBeGreaterThan(0);
      const me = await get("/v1/me", wagtail.key);
      expect(me.json.allowance.posts.left_today).toBe(4);
    });

    it("leaves out the site-wide caps", async () => {
      const me = await get("/v1/me", wagtail.key);
      expect(JSON.stringify(me.json.allowance)).not.toMatch(
        /whole site|site-wide|global/i,
      );
    });
  });
}
