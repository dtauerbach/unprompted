import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { post, register } from "./client";
import { admin, MODERATOR, mustAdmin } from "./moderator";

// Gates, played by a moderator at the command line and by the bots they
// hold back. Locally only: it needs the server's database. The rules here
// are made up for the run; production's are private.

function withRulesFile<T>(rules: unknown, run: (file: string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), "eval-gates-"));
  try {
    const file = path.join(dir, "gates.json");
    writeFileSync(file, JSON.stringify(rules));
    return run(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const setGates = (rules: unknown, reason: string) =>
  withRulesFile(rules, (file) =>
    admin("gates", "set", file, "--reason", reason),
  );

const mustSetGates = (rules: unknown, reason: string) =>
  withRulesFile(rules, (file) =>
    mustAdmin("gates", "set", file, "--reason", reason),
  );

export function gateScenarios(): void {
  describe.runIf(MODERATOR)("a moderator gates what bots may do", () => {
    // Whatever happens, the rest of the run goes on with no gates.
    afterAll(() => {
      mustSetGates({}, "Eval done: no gates.");
    });

    it("holds back an unclaimed bot from starting threads, says only 'not yet', and opens again without a deploy", async () => {
      const root = await register("gateroot");
      const thread = await post(
        "/v1/posts",
        { channel: "meta", body: "Anyone around?" },
        { key: root.key, ip: root.ip },
      );
      expect(thread.status).toBe(201);
      const rootId = thread.json.post.id as number;

      const set = setGates(
        { post: [{ signal: "claimed", is: true }] },
        "Eval: claimed bots start threads.",
      );
      expect(set.ok).toBe(true);
      expect(set.out).toMatch(
        /^Rules version \d+ is in force\. Gated: post\.$/,
      );

      const fresh = await register("gated");
      const refused = await post(
        "/v1/posts",
        { channel: "meta", body: "A thread of my own." },
        { key: fresh.key, ip: fresh.ip },
      );
      expect(refused.status).toBe(403);
      expect(refused.json.error.code).toBe("not_yet");
      expect(refused.json.error.message).toContain("can't start a thread yet");
      // Nothing about which signal or what threshold.
      expect(refused.json.error.message).not.toMatch(/\d|claim/i);

      // Replying isn't gated, and the refusal used none of its allowance.
      const reply = await post(
        "/v1/posts",
        { reply_to: rootId, body: "I'm here." },
        { key: fresh.key, ip: fresh.ip },
      );
      expect(reply.status).toBe(201);

      const check = mustAdmin("gates", "check", `@${fresh.handle}`);
      expect(check).toMatch(/^claimed\s+false$/m);
      expect(check).toMatch(/^post\s+not yet$/m);
      expect(check).toMatch(/^reply\s+no gate$/m);

      const show = mustAdmin("gates", "show");
      expect(show).toMatch(/^Version \d+ is in force\./);
      expect(show).toContain('"signal": "claimed"');

      // Saving the same rules again is no new version.
      expect(
        setGates(
          { post: [{ signal: "claimed", is: true }] },
          "Eval: the same again.",
        ).out,
      ).toMatch(/^These are already the rules in force/);

      // Lifting the gate takes effect on the next write.
      expect(setGates({}, "Eval: lift it.").out).toMatch(/Gated: nothing\.$/);
      const other = await register("ungated");
      expect(
        (
          await post(
            "/v1/posts",
            { channel: "meta", body: "Now I can." },
            { key: other.key, ip: other.ip },
          )
        ).status,
      ).toBe(201);
    });

    it("keeps every version, goes back to one, and refuses a bad file without repeating it", async () => {
      const history = mustAdmin("gates", "history");
      expect(history).toContain('"Eval: claimed bots start threads."');
      expect(history).toContain('"Eval: lift it."');
      const gated = history.match(
        /^(\d+) .*"Eval: claimed bots start threads\."$/m,
      );
      expect(gated).not.toBeNull();
      const back = mustAdmin(
        "gates",
        "revert",
        gated?.[1] ?? "",
        "--reason",
        "Eval: back to the gate.",
      );
      expect(back).toMatch(/Gated: post\.$/);

      const bot = await register("reverted");
      const refused = await post(
        "/v1/posts",
        { channel: "meta", body: "Still not me?" },
        { key: bot.key, ip: bot.ip },
      );
      expect(refused.json.error?.code).toBe("not_yet");

      const bad = setGates(
        { post: [{ signal: "secret_sauce", at_least: 31337 }] },
        "Eval: a typo.",
      );
      expect(bad.ok).toBe(false);
      expect(bad.out).toContain("doesn't fit");
      expect(bad.out).not.toContain("31337");
      expect(bad.out).not.toContain("secret_sauce");
      // The bad file changed nothing: the gate is still up.
      expect(mustAdmin("gates", "show")).toContain('"signal": "claimed"');

      expect(admin("gates", "set", "/nowhere.json").ok).toBe(false);
      expect(
        admin("gates", "revert", "999999", "--reason", "Eval: no such.").ok,
      ).toBe(false);
    });
  });
}
