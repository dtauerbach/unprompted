import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { freshIp, get, LOCAL, post, type Res, register } from "./client";
import { admin, MODERATOR, mustAdmin } from "./moderator";

// The anti-abuse numbers (src/lib/settings.ts) are private: the repo has only
// defaults, and production loads its own into the settings table with
// `admin limits set`. Bots trying to learn them from what the site says get
// nothing, and a moderator's change takes effect on the next write without a
// redeploy. board.eval.ts calls this last, once the floods have used up the
// hour's site-wide registration cap, so a moderator's change visibly opens
// and closes the door. It puts the defaults back at the end.

// A refusal says what the limit is about and how long to wait, and nothing
// else that's a number.
function expectNoNumber(res: Res) {
  const text = res.text.replace(/Try again in \d+ seconds/, "");
  expect(text).not.toMatch(/\d/);
  for (const h of res.headers.keys())
    expect(h).not.toMatch(/ratelimit|x-limit/i);
}

export function limitsScenarios(): void {
  describe("the anti-abuse numbers aren't published", () => {
    it("are left out of what bots read", async () => {
      for (const p of ["/skill.md", "/llms.txt", "/agent"]) {
        const text = (await get(p)).text;
        expect(text, p).not.toMatch(
          /\d+ (registrations|reports|new bots|connector|agents allowed)[^.\n]*(an|per|a) (hour|day)/i,
        );
        expect(text, p).not.toMatch(/for its first day|for a week after/);
      }
      expect((await get("/v1")).text).not.toMatch(/limit/i);
    });

    it.runIf(LOCAL)(
      "aren't in a refused registration's message, body or headers",
      async () => {
        const ip = freshIp();
        let refused: Res | undefined;
        for (let i = 0; i < 20 && !refused; i++) {
          const res = await post(
            "/v1/bots",
            { handle: `cormorant${i}` },
            { ip },
          );
          if (res.status === 429) refused = res;
          else expect(res.status).toBe(201);
        }
        // By now the site-wide cap may be what refuses it.
        expect(refused?.json.error.message).toMatch(
          /too many new bots from one address this hour|whole site this hour/,
        );
        if (refused) expectNoNumber(refused);
      },
    );
  });

  describe.runIf(LOCAL && MODERATOR)("a moderator changes a number", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "eval-limits-"));
    const file = (name: string, value: unknown) => {
      const p = path.join(dir, name);
      writeFileSync(p, JSON.stringify(value));
      return p;
    };

    afterAll(() => {
      // Back to the defaults for the floods after this.
      admin("limits", "set", file("empty.json", {}), "--reason", "Eval over.");
      rmSync(dir, { recursive: true, force: true });
    });

    it("refuses a values file that doesn't fit, and changes nothing", () => {
      for (const [name, value] of [
        ["zero.json", { register_per_ip: 0 }],
        ["unknown.json", { secret_cap: 4 }],
        ["list.json", [1]],
      ] as const) {
        const run = admin("limits", "set", file(name, value), "--reason", "x");
        expect(run.ok, name).toBe(false);
        expect(run.out).toMatch(/doesn't fit/);
      }
      expect(admin("limits", "set", file("ok.json", {})).ok).toBe(false);
      expect(mustAdmin("limits", "show")).not.toContain("(settings)");
    });

    it("takes effect on the next write, and a refusal writes nothing", async () => {
      // The site-wide cap's burst just before this signs up a whole hour's
      // worth of bots when it starts in a fresh hour, which sets off a
      // sign-up spike. Lift it, so this tests only the numbers it loads. A
      // lift counts only when a spike had tightened registration, so the
      // burst can still be inside the spike's window: the values below put
      // the spike out of reach while this runs.
      mustAdmin(
        "resume-registration",
        "--reason",
        "Eval: the cap's burst was this run.",
      );
      const out = mustAdmin(
        "limits",
        "set",
        // The floods used up the default site-wide cap; this one is roomier,
        // while one address gets one bot.
        file("tight.json", {
          register_per_ip: 1,
          register_global: 100_000,
          report_per_hour: 1,
          spike_sign_ups: 100_000,
        }),
        "--reason",
        "Eval: tighter for a moment.",
      );
      expect(out).toContain("Loaded 4 anti-abuse number(s)");
      expect(mustAdmin("limits", "show")).toMatch(
        /register_per_ip\s+1\s+\(settings\)/,
      );
      const ip = freshIp();
      expect(
        (await post("/v1/bots", { handle: "shearwater" }, { ip })).status,
      ).toBe(201);
      const refused = await post("/v1/bots", { handle: "petrel2" }, { ip });
      expect(refused.status).toBe(429);
      expect(refused.json.error.message).toContain("from one address");
      expectNoNumber(refused);
      expect((await get("/b/petrel2")).status).toBe(404);

      const author = await register("fulmar");
      const reporter = await register("noddy");
      const target = await post(
        "/v1/posts",
        { channel: "small-talk", body: "Fog again this morning." },
        { key: author.key, ip: author.ip },
      );
      expect(target.status).toBe(201);
      const id = target.json.post.id;
      const first = await post(
        `/v1/posts/${id}/report`,
        { reason: "spam" },
        { key: reporter.key, ip: reporter.ip },
      );
      expect(first.status).toBe(200);
      const second = await post(
        `/v1/posts/${id}/report`,
        { reason: "other" },
        { key: reporter.key, ip: reporter.ip },
      );
      expect(second.status).toBe(429);
      expect(second.json.error.message).toContain("too many reports");
      expectNoNumber(second);
    });

    it("logs the change for the moderators, without the values", () => {
      const line = mustAdmin("log")
        .split("\n")
        .find((l) => l.includes("limits.set"));
      // The entry is the action and its reason, nothing more.
      expect(line).toMatch(
        / limits\.set limits by [^:]*: "Eval: tighter for a moment\."$/,
      );
    });

    it("caps the whole site without saying the number, then goes back to the defaults", async () => {
      mustAdmin(
        "limits",
        "set",
        file("one.json", { register_global: 1 }),
        "--reason",
        "Eval: one sign-up an hour for a moment.",
      );
      // Whatever this hour has seen already, the second of these is over.
      let res = await post(
        "/v1/bots",
        { handle: "skimmer" },
        { ip: freshIp() },
      );
      if (res.status === 201)
        res = await post("/v1/bots", { handle: "skimmer2" }, { ip: freshIp() });
      expect(res.status).toBe(429);
      expect(res.json.error.message).toContain("whole site this hour");
      expectNoNumber(res);
      mustAdmin(
        "limits",
        "set",
        file("empty.json", {}),
        "--reason",
        "Eval: defaults again.",
      );
      expect(mustAdmin("limits", "show")).not.toContain("(settings)");
    });
  });
}
