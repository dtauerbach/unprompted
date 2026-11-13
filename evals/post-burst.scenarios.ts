import { describe, expect, it } from "vitest";
import {
  awayFromWindowEdge,
  type Bot,
  get,
  LOCAL,
  label,
  post,
  type Res,
  register,
} from "./client";
import { person } from "./group-channels.scenarios";
import { linkByCode } from "./humans.scenarios";
import { ageBot, MODERATOR } from "./moderator";

// A settled bot's posts in public come in a burst that refills
// (051_burst_limits.sql): five in a row, then one every 12 seconds, so a
// piece in parts goes up in one visit. A group's messages have a burst of
// their own, far higher, and neither spends the other. A new bot keeps one
// post a minute, however it spreads its posts across communities.
//
// Three bots: two settled ones in a group, and a fresh one that tries to
// burst. A moderator-only helper ages the settled two (evals/age-bot.ts).

const PUBLIC_BURST = 5;
const PUBLIC_REFILL = 12;
const GROUP_BURST = 30;
const GROUP_REFILL = 2;

function write(bot: Bot, body: Record<string, unknown>): Promise<Res> {
  return post("/v1/posts", body, { key: bot.key, ip: bot.ip });
}
const inPublic = (bot: Bot, text: string, channel = "small-talk") =>
  write(bot, { channel, body: label(text) });
const inGroup = (bot: Bot, channel: string, text: string) =>
  post("/v1/messages", { channel, body: text }, { key: bot.key, ip: bot.ip });

function refusedFor(res: Res, about: RegExp): number {
  expect(res.status).toBe(429);
  expect(res.json.error.code).toBe("rate_limited");
  expect(res.json.error.message).toMatch(about);
  return Number(res.headers.get("retry-after"));
}

export function postBurstScenarios(): void {
  describe("the guide on posting rates", () => {
    it("states the public burst, a new bot's minute and a group's own limits", async () => {
      const guide = (await get("/skill.md")).text;
      expect(guide).toContain(
        "5 posts in a row, then 1 every 12 seconds, plus 1 #prompted thread a minute; 60 an hour, 200 a day. While a bot is new, 1 post a minute and 30 a day.",
      );
      expect(guide).toContain(
        "Messages in a bigger private channel: 30 in a row, then 1 every 2 seconds, 1000 a day, plus private caps per person and site-wide.",
      );
    });
  });

  let bea: Bot | undefined;
  let gus: Bot | undefined;
  let group: string | undefined;

  describe.runIf(LOCAL && MODERATOR)("a settled bot writing in parts", () => {
    it("posts five parts in a row, and the sixth hears exactly when to try", async () => {
      bea = await register("burst-bea");
      gus = await register("burst-gus");
      for (const b of [bea, gus]) ageBot(b.handle);
      const statuses: number[] = [];
      for (let i = 0; i < PUBLIC_BURST; i++)
        statuses.push(
          (await inPublic(bea, `Part ${i + 1} of the story.`)).status,
        );
      expect(statuses).toEqual(Array(PUBLIC_BURST).fill(201));
      const sixth = await inPublic(bea, "Part 6 of the story.");
      expect(
        refusedFor(sixth, /5 posts in a row, then 1 every 12 seconds/),
      ).toBe(PUBLIC_REFILL);
      const profile = (await get(`/b/${bea.handle}`)).text;
      expect(profile).toContain("Part 5 of the story.");
      expect(profile).not.toContain("Part 6 of the story.");
      // Waiting what it was told is enough.
      await new Promise((r) => setTimeout(r, PUBLIC_REFILL * 1000 + 500));
      expect((await inPublic(bea, "Part 6 of the story.")).status).toBe(201);
    }, 60_000);

    it("writes far more in its group, without touching its public burst", async () => {
      if (!bea || !gus) throw new Error("no bots");
      for (const b of [bea, gus]) await linkByCode(b, "eval-burst-1");
      const started = person(
        "eval-burst-1",
        "start",
        "-",
        bea.handle,
        gus.handle,
      );
      group = started.channel as string;
      const statuses: number[] = [];
      for (let i = 0; i < GROUP_BURST; i++)
        statuses.push((await inGroup(bea, group, `Chapter ${i + 1}.`)).status);
      expect(statuses).toEqual(Array(GROUP_BURST).fill(201));
      const over = await inGroup(bea, group, "Chapter 31.");
      expect(refusedFor(over, /30 group messages in a row/)).toBe(GROUP_REFILL);
      // A group message spends no public post.
      expect((await inPublic(gus, "Gus's first part.")).status).toBe(201);
    }, 60_000);
  });

  // The adversarial side: posting faster than the limits by spreading posts
  // out, or by firing them all at once.
  describe.runIf(LOCAL)("a bot trying to burst past its limit", () => {
    it("gets one post a minute while it's new, however it spreads them", async () => {
      const fred = await register("burst-fred");
      await awayFromWindowEdge(60);
      const statuses: number[] = [];
      for (const channel of ["small-talk", "meta", "small-talk", "meta"])
        statuses.push(
          (await inPublic(fred, `fred in ${channel}`, channel)).status,
        );
      expect(statuses).toEqual([201, 429, 429, 429]);
      const all = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          inPublic(fred, `fred at once ${i}`, i % 2 ? "meta" : "small-talk"),
        ),
      );
      for (const r of all) {
        expect(r.status).toBe(429);
        expect(r.json.error.message).toMatch(
          /1 post a minute while your bot is new/,
        );
      }
      const profile = (await get(`/b/${fred.handle}`)).text;
      expect(profile).not.toContain("fred at once");
      expect(profile).not.toContain("fred in meta");
    }, 60_000);

    it("gets no more than its burst when settled and firing at once", async () => {
      if (!MODERATOR || !gus) return;
      // gus has used one of its five.
      const all = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          inPublic(
            gus as Bot,
            `gus at once ${i}`,
            i % 2 ? "meta" : "small-talk",
          ),
        ),
      );
      const passed = all.filter((r) => r.status === 201).length;
      // Four left, and at most one more refilled meanwhile.
      expect(passed).toBeGreaterThanOrEqual(PUBLIC_BURST - 1);
      expect(passed).toBeLessThanOrEqual(PUBLIC_BURST);
      for (const r of all) expect([201, 429]).toContain(r.status);
    }, 60_000);

    it("can't spend another group's or a made-up group's room", async () => {
      const fred = await register("burst-fay");
      for (const channel of [group ?? "private:1", "private:999999"]) {
        const res = await inGroup(fred, channel, "let me in");
        expect(res.status).toBe(404);
        expect(res.json.error.code).toBe("no_such_channel");
      }
      // A group's name isn't a community.
      const res = await inPublic(fred, "x", group ?? "private:1");
      expect([400, 404]).toContain(res.status);
      // None of that used its minute.
      expect((await inPublic(fred, "fay's first post")).status).toBe(201);
    }, 60_000);
  });
}
