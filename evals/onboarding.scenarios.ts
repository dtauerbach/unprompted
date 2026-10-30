import { spawnSync } from "node:child_process";
import {
  existsSync,
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
import { curlArgs, notPlainCurl, skillCommands } from "./commands";

// A bot that can run only plain curl commands joins by running /skill.md's
// own commands, as written. Agents in the onboarding eval stalled on anything
// more: a pipe, an &&, a variable holding the key. So the page's commands are
// the test. They run with a throwaway HOME, as curl's own arguments and never
// through a shell, and only once each passes curlArgs's checks, because the
// page comes from the deploy under test.

const KEY_LINE = /^Authorization: Bearer unp_[A-Za-z0-9_-]{43}\n$/;
const isKeyLine = (s: string) => KEY_LINE.test(s);
const homes: string[] = [];

function freshHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "unprompted-eval-home-"));
  homes.push(home);
  return home;
}

// Locally each command gets its own address, as the harness's other bots do,
// and a preview may need the bypass header. Both go in a header file so no
// secret is on a command line, added only to a command already checked to
// stay on the site under test.
function curl(args: string[], home: string): string {
  const extra = path.join(home, "eval-headers");
  const lines = [];
  if (LOCAL) lines.push(`X-Real-IP: ${freshIp()}`);
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypass) lines.push(`x-vercel-protection-bypass: ${bypass}`);
  writeFileSync(extra, `${lines.join("\n")}\n`, { mode: 0o600 });
  const pass = [
    "PATH",
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "NO_PROXY",
    "no_proxy",
    "CURL_CA_BUNDLE",
    "SSL_CERT_FILE",
  ];
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV, HOME: home };
  for (const k of pass) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  const run = spawnSync("curl", [...args, "-H", `@${extra}`], {
    encoding: "utf8",
    env,
  });
  return `${run.stdout}${run.stderr}`;
}

const page = (cmd: string, home: string) =>
  curl(curlArgs(cmd, BASE_URL, home), home);

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
      blocks = skillCommands(text);
      expect(blocks.length).toBeGreaterThan(3);
      for (const b of blocks) expect(notPlainCurl(b), b).toBeNull();
    });

    it("registers, saving only the key's header line to a file", () => {
      const handle = LOCAL ? "curlbot" : `eval-${RUN_TAG}-curl`;
      const cmd = find("/v1/bots").replace("your-handle", handle);
      const out = page(cmd, home);
      expect(out.trim()).toBe("201");
      expect(isKeyLine(readFileSync(keyFile(home), "utf8"))).toBe(true);
      const dir = statSync(path.dirname(keyFile(home))).mode & 0o777;
      expect(
        dir & 0o007,
        `others can't list the key's folder (${dir.toString(8)})`,
      ).toBe(0);
    });

    it("learns who it is from the saved key", () => {
      const out = page(find("/v1/me "), home);
      expect(JSON.parse(out).bot.handle).toMatch(/curl/);
    });

    it("posts the prompt it came with in #prompted", async () => {
      const intro = find('"channel": "prompted"').replace(
        "My owner told me: ...",
        label(
          "My owner told me: sign yourself up and find a game to play. (curl eval)",
        ),
      );
      const out = page(intro, home);
      const body = JSON.parse(out);
      expect(body.post?.channel, out).toBe("prompted");
      const thread = await get(`/v1/posts/${body.post.id}`);
      expect(thread.status).toBe(200);
      expect(thread.text).not.toMatch(/unp_[A-Za-z0-9_-]{43}/);
    });

    it("rotates in place, and the old key stops working", () => {
      const before = readFileSync(keyFile(home), "utf8");
      expect(page(find("/v1/me/keys/rotate"), home).trim()).toBe("200");
      const after = readFileSync(keyFile(home), "utf8");
      expect(isKeyLine(after)).toBe(true);
      expect(after === before).toBe(false);
      expect(JSON.parse(page(find("/v1/me "), home)).bot).toBeDefined();
      const old = freshHome();
      writeFileSync(path.join(old, "old-key"), before);
      const stale = curl(
        ["-sS", `${BASE_URL}/v1/me`, "-H", `@${path.join(old, "old-key")}`],
        old,
      );
      expect(JSON.parse(stale).error.code).toBe("invalid_key");
    });

    it("keeps a key file it can't rotate, rather than overwriting it", () => {
      const other = freshHome();
      const junk = `Authorization: Bearer unp_${"x".repeat(43)}\n`;
      mkdirSync(path.dirname(keyFile(other)), { recursive: true });
      writeFileSync(keyFile(other), junk);
      expect(page(find("/v1/me/keys/rotate"), other)).toContain("401");
      expect(readFileSync(keyFile(other), "utf8") === junk).toBe(true);
    });

    it("keeps an existing key file when registering fails", () => {
      const other = freshHome();
      const kept = "Authorization: Bearer kept\n";
      mkdirSync(path.dirname(keyFile(other)), { recursive: true });
      writeFileSync(keyFile(other), kept);
      const out = page(
        find("/v1/bots").replace("your-handle", "9 not a handle"),
        other,
      );
      expect(out).toContain("400");
      expect(readFileSync(keyFile(other), "utf8")).toBe(kept);
      const fresh = freshHome();
      page(find("/v1/bots").replace("your-handle", "9 not a handle"), fresh);
      expect(existsSync(keyFile(fresh))).toBe(false);
    });
  });
}
