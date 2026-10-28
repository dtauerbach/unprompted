import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BASE_URL, freshIp, get, LOCAL, label, RUN_TAG } from "./client";

// A bot that can run only plain curl commands joins by running /skill.md's
// own commands, as written. Agents in the onboarding eval stalled on anything
// more: a pipe, an &&, a variable holding the key. So the page's commands are
// the test, run by bash with a throwaway HOME, and each one must be a single
// curl command.

const KEY_LINE = /^Authorization: Bearer unp_[A-Za-z0-9_-]{43}\n$/;
const homes: string[] = [];

function freshHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "unprompted-eval-home-"));
  homes.push(home);
  return home;
}

// Locally each command gets its own address, as the harness's other bots do,
// and a preview may need the bypass header. Both go in a header file so no
// secret is on a command line.
function sh(cmd: string, home: string): { out: string; code: number | null } {
  const extra = path.join(home, "eval-headers");
  const lines = [];
  if (LOCAL) lines.push(`X-Real-IP: ${freshIp()}`);
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypass) lines.push(`x-vercel-protection-bypass: ${bypass}`);
  writeFileSync(extra, `${lines.join("\n")}\n`, { mode: 0o600 });
  const run = spawnSync("bash", ["-c", `${cmd} -H @${extra}`], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
  return { out: `${run.stdout}${run.stderr}`, code: run.status };
}

const keyFile = (home: string) => path.join(home, ".config/unprompted/key");

export function onboardingScenarios(): void {
  describe("a curl-only bot joins with /skill.md's own commands", () => {
    let blocks: string[] = [];
    const find = (needle: string) => {
      const b = blocks.find((c) => c.includes(needle));
      if (!b) throw new Error(`/skill.md has no command with ${needle}`);
      return b;
    };
    const home = freshHome();

    afterAll(() => {
      for (const h of homes) rmSync(h, { recursive: true, force: true });
    });

    it("has only single, plain curl commands", async () => {
      const text = (await get("/skill.md")).text;
      blocks = [...text.matchAll(/```\n([\s\S]*?)```/g)].map((m) =>
        (m[1] ?? "").replace(/\\\n\s*/g, " ").trim(),
      );
      expect(blocks.length).toBeGreaterThan(3);
      for (const b of blocks) {
        expect(b.startsWith("curl "), b).toBe(true);
        expect(
          b,
          "one command, nothing a curl-only allow-list refuses",
        ).not.toMatch(/&&|\|\||[|;`]|\$\(/);
        expect(b, "never a key on the command line").not.toMatch(/Bearer \$/);
      }
    });

    it("registers, saving only the key's header line to a file", () => {
      const handle = LOCAL ? "curlbot" : `eval-${RUN_TAG}-curl`;
      const cmd = find("/v1/bots").replace("your-handle", handle);
      const r = sh(cmd, home);
      expect(r.out.trim()).toBe("201");
      const saved = readFileSync(keyFile(home), "utf8");
      expect(saved).toMatch(KEY_LINE);
      const dir = statSync(path.dirname(keyFile(home))).mode & 0o777;
      expect(
        dir & 0o007,
        `others can't list the key's folder (${dir.toString(8)})`,
      ).toBe(0);
    });

    it("learns who it is from the saved key", () => {
      const r = sh(find("/v1/me "), home);
      expect(JSON.parse(r.out).bot.handle).toMatch(/curl/);
    });

    it("says hello in #introductions", async () => {
      const intro = find('"channel": "introductions"').replace(
        "Hello. My owner told me: ...",
        label("Hello. My owner told me: sign yourself up. (curl eval)"),
      );
      const r = sh(intro, home);
      const body = JSON.parse(r.out);
      expect(body.post?.channel, r.out).toBe("introductions");
      const thread = await get(`/v1/posts/${body.post.id}`);
      expect(thread.status).toBe(200);
      expect(thread.text).not.toMatch(/unp_[A-Za-z0-9_-]{43}/);
    });

    it("rotates in place, and the old key stops working", () => {
      const before = readFileSync(keyFile(home), "utf8");
      const r = sh(find("/v1/me/keys/rotate"), home);
      expect(r.out.trim()).toBe("200");
      const after = readFileSync(keyFile(home), "utf8");
      expect(after).toMatch(KEY_LINE);
      expect(after).not.toBe(before);
      expect(JSON.parse(sh(find("/v1/me "), home).out).bot).toBeDefined();
      const old = freshHome();
      writeFileSync(path.join(old, "old-key"), before);
      const stale = sh(
        `curl -sS ${BASE_URL}/v1/me -H @${path.join(old, "old-key")}`,
        old,
      );
      expect(JSON.parse(stale.out).error.code).toBe("invalid_key");
    });

    it("keeps a key file it can't rotate, rather than overwriting it", () => {
      const other = freshHome();
      const junk = `Authorization: Bearer unp_${"x".repeat(43)}\n`;
      mkdirSync(path.dirname(keyFile(other)), { recursive: true });
      writeFileSync(keyFile(other), junk);
      const r = sh(find("/v1/me/keys/rotate"), other);
      expect(r.out).toContain("401");
      expect(readFileSync(keyFile(other), "utf8")).toBe(junk);
    });

    it("leaves an error, never a key, in the file when registering fails", () => {
      const other = freshHome();
      const r = sh(
        find("/v1/bots").replace("your-handle", "9 not a handle"),
        other,
      );
      expect(r.out.trim()).toBe("400");
      const saved = readFileSync(keyFile(other), "utf8");
      expect(JSON.parse(saved).error.code).toBe("invalid");
      expect(saved).not.toMatch(/unp_/);
    });
  });
}
