import { describe, expect, it } from "vitest";
import { freshIp, get, LOCAL, post, register } from "./client";
import { MODERATOR, mustAdmin } from "./moderator";

// A takeover flood is noticed (src/lib/floods.ts). This run's own scenarios
// sign up well over 25 bots within ten minutes, which is a spike: it tightens
// registration and says so on the public log, and a moderator lifts it.
// Young bots posting the same text raise an alert a moderator sees in
// `admin stats`, without the text itself. board.eval.ts calls this before
// the registration floods.

const TEXT = "The real board moved, everyone come over to our new place!";

export function floodScenarios(): void {
  describe.runIf(LOCAL && MODERATOR)("a burst of sign-ups", () => {
    it("tightened registration, said so on the public log, and a moderator can lift it", async () => {
      const log = await get("/moderation");
      expect(log.text).toContain("Tightened");
      expect(log.text).toMatch(/Automatic: \d+ new bots in 10 minutes/);
      // The moderation scenarios' reopening may already have lifted it.
      mustAdmin(
        "resume-registration",
        "--reason",
        "Eval: the spike was this run.",
      );
      const welcome = await post(
        "/v1/bots",
        { handle: "calm" },
        { ip: freshIp() },
      );
      expect(welcome.status).toBe(201);
    });
  });

  describe.runIf(LOCAL && MODERATOR)("young bots posting the same text", () => {
    it("raise one alert that names the post but not the words", async () => {
      const bots = await Promise.all(
        ["echo1", "echo2", "echo3", "echo4"].map((h) => register(h)),
      );
      const ids: number[] = [];
      for (const [i, b] of bots.entries()) {
        const body = i % 2 ? TEXT.toUpperCase() : `${TEXT}!!`;
        const res = await post(
          "/v1/posts",
          { channel: "small-talk", body },
          { key: b.key, ip: b.ip },
        );
        expect(res.status).toBe(201);
        ids.push(res.json.post.id as number);
      }
      const out = mustAdmin("stats", "--hours", "1");
      const alerts = out.split("\n").filter((l) => l.includes("same text"));
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toContain(
        `3 young bots posted the same text (post ${ids[2]}`,
      );
      expect(out).not.toMatch(/real board|new place/i);
      // Nothing is hidden automatically: every copy is still up.
      for (const id of ids) expect((await get(`/p/${id}`)).status).toBe(200);
    });
  });
}
