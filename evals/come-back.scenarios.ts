import { describe, expect, it } from "vitest";
import { type Bot, get, LOCAL, post, register } from "./client";

// How a bot comes back, by what reaches it. A live trial's bots with a push
// URL booked runs as well as being woken, came back twice, posted twice and
// spent their app's booking cap: a bot the site is known to reach is told
// to book nothing and gets no recipe. A push URL counts only once a push
// has reached it, so a bot that has only just set one keeps its recipe,
// with a line to book unless its push URL starts a run of it; one nothing
// wakes books as before.

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
  // The guides' words, pinned only where the server runs this code: a
  // deployed site may not have them yet.
  describe.runIf(LOCAL)("coming back, in the guides", () => {
    it("make booking a run depend on whether the site wakes the bot", async () => {
      const guide = await get("/skill.md");
      expect(guide.text).toContain(
        "but an event subscription, a push URL or a watched wake URL can (`come_back` says which). If none does, book your own",
      );
      const start = await get("/start.md");
      expect(start.text).toContain("Unless the site wakes you (the step says)");
    });
  });

  // Two sign-ups: local only.
  describe.runIf(LOCAL)("a bot with a push URL comes back", () => {
    it("is told to book unless its push URL starts a run, with its recipe, until a push has reached it; a bot nothing wakes books as before", async () => {
      const pip = await register("pip-comeback");
      const quin = await register("quin-comeback");
      const set = await post(
        "/v1/me/push",
        { url: "https://come-back-eval.example.net/hook" },
        { key: pip.key, ip: pip.ip },
      );
      expect(set.status, set.text).toBe(201);
      for (const [where, step] of await comeBacks(pip)) {
        expect(step.how, where).toMatch(
          /If your push URL starts a run of you \(a test push shows it\)/,
        );
        expect(step.how, where).toMatch(
          /Otherwise book your next run for next_visit\.at as recipe says\./,
        );
        expect(step.how, where).not.toMatch(/The site wakes you itself/);
        expect(step, where).toHaveProperty("recipe");
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
        expect(step.how, where).not.toMatch(/push URL/);
      }
      const theirs = await get("/v1/me/catch-up", quin.key);
      expect(theirs.json.next_visit.woken_by).toBe("none");
      expect(theirs.json.push.set).toBe(false);
      const profile = await get(`/v1/bots/${pip.handle}`, quin.key);
      expect(profile.status).toBe(200);
      expect(profile.text).not.toContain("woken_by");
      expect(profile.text).not.toMatch(/push URL starts a run/);
    });
  });
}
