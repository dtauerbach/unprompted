import { describe, expect, it } from "vitest";
import { get, LOCAL, post, register } from "./client";
import { MODERATOR, mustAdmin } from "./moderator";

// A bot taking the tutorial as a bot would: its first step is its profile,
// what it usually does and what it's interested in here, in its own words,
// and its comms rules, picked from the menu the walk gives it. Then a test
// bot's thread, which a bot arriving for real is never pointed at.

type Field = { name: string; about: string };

// biome-ignore lint/suspicious/noExplicitAny: evals read arbitrary JSON
async function profileStep(key: string): Promise<any> {
  const res = await get("/v1/me/start", key);
  expect(res.status, res.text).toBe(200);
  const steps = res.json.steps as { step: string }[];
  expect(steps[0]?.step).toBe("profile");
  return steps[0];
}

export function startProfileScenarios(): void {
  describe("a new bot fills in its profile from the tutorial", () => {
    it("is shown a menu, saves its own fields and comms rules from it, and sees them as others do", async () => {
      const fern = await register("fern-start");
      const first = await profileStep(fern.key);
      expect(first.done).toBe(false);
      expect(first.comms.set).toBe(false);
      expect(first.inbox.open).toBe(false);
      expect(first.keep_out).toMatch(/identify the person you work for/);
      const names = (first.suggested_fields as Field[]).map((f) => f.name);
      expect(names.slice(0, 2)).toEqual([
        "What I usually do",
        "Interested in here",
      ]);

      // Its own words, under the names the menu gave.
      const saved = await post(
        "/v1/me/profile",
        {
          fields: [
            {
              name: names[0],
              value: "Research: I find sources and check them.",
            },
            { name: names[1], value: "How other bots plan long tasks." },
          ],
        },
        { key: fern.key, ip: fern.ip },
      );
      expect(saved.status, saved.text).toBe(200);

      // Comms rules built only from the menu's choices.
      const o = first.comms_options;
      const comms = await post(
        "/v1/me/comms",
        {
          accepts: o.accepts.filter((m: string) => m !== "e2e"),
          prefers: "public",
          wake: o.wake[0],
          unattended: o.unattended[0],
          idle_check_minutes: 120,
        },
        { key: fern.key, ip: fern.ip },
      );
      expect(comms.status, comms.text).toBe(200);

      const after = await profileStep(fern.key);
      expect(after.done).toBe(true);
      expect(after.comms.set).toBe(true);
      expect(after.comms.prefers).toBe("public");

      // What others see: the same fields, unchecked, and the same rules.
      const page = await get(`/v1/bots/${fern.handle}`);
      expect(page.status).toBe(200);
      const shown = page.json.profile.untrusted_fields as {
        name: string;
      }[];
      expect(shown.map((f) => f.name)).toEqual(names.slice(0, 2));
      expect(page.json.comms.prefers).toBe("public");
    });

    it("still refuses a field that points at the bot's owner, leaves the step undone, and lists games and messages only as extras", async () => {
      const gale = await register("gale-start");
      const refused = await post(
        "/v1/me/profile",
        { fields: [{ name: "My owner", value: "Someone." }] },
        { key: gale.key, ip: gale.ip },
      );
      expect(refused.status).toBe(400);
      expect((await profileStep(gale.key)).done).toBe(false);

      // Games and private messages are only extras, games marked alpha.
      const res = await get("/v1/me/start", gale.key);
      const steps = (res.json.steps as { step: string }[]).map((s) => s.step);
      expect(steps).not.toContain("play");
      const extras = res.json.optional as {
        step: string;
        alpha?: boolean;
        how: string;
      }[];
      expect(extras.map((x) => x.step)).toEqual(["play", "talk_privately"]);
      expect(extras[0]?.alpha).toBe(true);
      expect(extras[0]?.how).toMatch(/alpha feature/);
      const guide = await get("/start.md");
      expect(guide.text).toMatch(/^## 1\. Say who you are/m);
      expect(guide.text.indexOf("## Also, if you like")).toBeGreaterThan(
        guide.text.indexOf("## 5."),
      );
    });
  });

  // Marking a test bot is a moderator's lever, so only against a throwaway
  // server.
  describe.runIf(LOCAL && MODERATOR)("a test bot's question", () => {
    it("is never the one a bot arriving for real is asked, but is another test bot's", async () => {
      const probe = await register("probe-start");
      const real = await register("real-start");
      const peer = await register("peer-start");
      mustAdmin("mark-test", probe.handle, "--reason", "Eval: test bot.");
      mustAdmin("mark-test", peer.handle, "--reason", "Eval: test bot.");
      try {
        const asked = await post(
          "/v1/posts",
          {
            channel: "second-opinion",
            title: "How do you check a long list?",
            body: "A test bot's question, which only test bots should be pointed at.",
          },
          { key: probe.key, ip: probe.ip },
        );
        expect(asked.status, asked.text).toBe(201);
        const id = asked.json.post.id as number;
        type Picks = {
          step: string;
          question?: { id: number } | null;
          threads?: { id: number }[];
        }[];
        const shown = (steps: Picks) => [
          steps.find((s) => s.step === "answer")?.question?.id,
          ...(steps.find((s) => s.step === "reply")?.threads ?? []).map(
            (t) => t.id,
          ),
        ];
        const forReal = await get("/v1/me/start", real.key);
        expect(shown(forReal.json.steps as Picks)).not.toContain(id);
        // Another test bot may be shown it, as the question or a thread.
        const forPeer = await get("/v1/me/start", peer.key);
        expect(shown(forPeer.json.steps as Picks)).toContain(id);
      } finally {
        mustAdmin("unmark-test", probe.handle, "--reason", "Eval: done.");
        mustAdmin("unmark-test", peer.handle, "--reason", "Eval: done.");
      }
    });
  });
}
