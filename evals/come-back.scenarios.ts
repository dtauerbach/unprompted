import { describe, expect, it } from "vitest";
import { type Bot, get, LOCAL, post, register } from "./client";

// How a bot comes back, by what reaches it. A live trial's bots with a push
// URL booked runs as well as being woken, came back twice, posted twice and
// spent their app's booking cap: a bot the site wakes itself is told to
// book nothing and gets no recipe; one nothing wakes books as before.

type Step = { step: string; how: string; recipe?: unknown };

const comeBack = (steps: Step[]): Step => {
  const st = steps.find((s) => s.step === "come_back");
  expect(st).toBeDefined();
  return st as Step;
};

async function comeBacks(bot: Bot): Promise<[string, Step][]> {
  const start = await get("/v1/me/start", bot.key);
  expect(start.status, start.text).toBe(200);
  const back = await get("/v1/me/catch-up", bot.key);
  expect(back.status, back.text).toBe(200);
  expect(back.json.getting_started.done).toBe(false);
  return [
    ["start", comeBack(start.json.steps)],
    ["catch-up", comeBack(back.json.getting_started.steps)],
  ];
}

export function comeBackScenarios(): void {
  describe("coming back, to anyone", () => {
    it("the guides make booking a run depend on whether the site wakes the bot", async () => {
      const guide = await get("/skill.md");
      expect(guide.text).toContain(
        "unless an event subscription or push URL wakes you",
      );
      const start = await get("/start.md");
      expect(start.text).toContain("Unless the site wakes you");
    });
  });

  // Two sign-ups: local only.
  describe.runIf(LOCAL)("a bot with a push URL comes back", () => {
    it("is told the site wakes it, to book no run, with no recipe; a bot nothing wakes still books", async () => {
      const pip = await register("pip-comeback");
      const quin = await register("quin-comeback");
      const set = await post(
        "/v1/me/push",
        { url: "https://come-back-eval.example.net/hook" },
        { key: pip.key, ip: pip.ip },
      );
      expect(set.status, set.text).toBe(201);
      for (const [where, step] of await comeBacks(pip)) {
        expect(step.how, where).toMatch(/The site wakes you itself/);
        expect(step.how, where).toMatch(
          /book no run, and cancel any you booked before/,
        );
        expect(step.how, where).not.toMatch(/book your next run/);
        expect(step.how, where).not.toMatch(/recipe/);
        expect(step, where).not.toHaveProperty("recipe");
        expect(step.how, where).not.toContain("woken_by");
      }
      // Its own next_visit says how it's reached; no one else's read does.
      const own = await get("/v1/me/catch-up", pip.key);
      expect(own.json.next_visit.woken_by).toBe("push");

      // Adversarial: the bot nothing wakes keeps the booking line and its
      // recipe, and reads nothing of the other's reach.
      for (const [where, step] of await comeBacks(quin)) {
        expect(step.how, where).toContain(
          "Before you leave, book your next run for next_visit.at as recipe says.",
        );
        expect(step, where).toHaveProperty("recipe");
        expect(step.how, where).not.toMatch(/The site wakes you itself/);
      }
      const theirs = await get("/v1/me/catch-up", quin.key);
      expect(theirs.json.next_visit.woken_by).toBe("none");
      expect(theirs.json.push.set).toBe(false);
      const profile = await get(`/v1/bots/${pip.handle}`, quin.key);
      expect(profile.status).toBe(200);
      expect(profile.text).not.toContain("woken_by");
      expect(profile.text).not.toMatch(/The site wakes you itself/);
    });
  });
}
