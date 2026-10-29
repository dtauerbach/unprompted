import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { type Bot, get, LOCAL, post, register, request } from "./client";
import { MODERATOR } from "./moderator";

// A human signs in, gets an owner code, and gives it to their agent, which
// joins linked to them or links itself later. Google sign-in can't run here,
// so locally a script plays the signed-in human (evals/owner-code.ts). The
// rest runs against any server, and writes nothing.

const BOGUS = "own_AAAAAAAAAAAAAAAAAAAAAA";

function ownerCode(signInId: string): string {
  // src/lib is server-only; this condition is how a server build loads it.
  const run = spawnSync(
    "npx",
    ["tsx", "--conditions=react-server", "evals/owner-code.ts", signInId],
    { encoding: "utf8" },
  );
  if (run.status !== 0) throw new Error(`owner-code: ${run.stderr}`);
  return run.stdout.trim();
}

export function humanScenarios(bot: () => Bot): void {
  describe("a human signs in", () => {
    // Signing in is a side door: the menu's "Your bots" leads to it.
    it("finds the sign-in page from the menu", async () => {
      const home = await get("/");
      expect(home.text).toMatch(/href="\/account"[^>]*>Your bots</);
      const page = await get("/sign-in");
      expect(page.status).toBe(200);
      expect(page.text).toMatch(
        /Sign in with Google|Signing in isn(&#x27;|')t available/,
      );
      expect(page.text).toContain("keep track of the bots you send");
    });

    it("can't see an account page without signing in", async () => {
      const res = await get("/account");
      // Where sign-in is set up, the proxy sends them to sign in. Elsewhere
      // the page says it isn't available. Either way, no code and no bots.
      if (res.status === 307) {
        expect(
          new URL(res.headers.get("location") ?? "", "http://x").pathname,
        ).toBe("/sign-in");
      } else {
        expect(res.status).toBe(200);
        expect(res.text).toMatch(/isn(&#x27;|')t available/);
      }
      expect(res.text).not.toContain("own_");
    });

    it("can't fake a session with made-up cookies", async () => {
      const res = await request("GET", "/account", {
        headers: {
          cookie:
            "__Secure-neon-auth.session_token=forged; __Secure-neon-auth.local.session_data=eyJhbGciOiJub25lIn0.eyJ1c2VyIjp7ImlkIjoieCJ9fQ.",
        },
      });
      expect(res.text).not.toContain("Send a bot");
      expect(res.text).not.toContain("Sign out");
      expect(res.text).not.toContain("own_");
    });
  });

  describe("a bot with a bad owner code", () => {
    it("isn't registered, and uses none of its address's quota", async () => {
      const res = await post("/v1/bots", {
        handle: "never-made",
        owner_code: BOGUS,
      });
      expect(res.status).toBe(400);
      expect(res.json.error.code).toBe("invalid_owner_code");
      expect((await get("/b/never-made")).status).toBe(404);
    });

    it("can't link itself with one, or without a key", async () => {
      const none = await post("/v1/me/owner", { owner_code: BOGUS });
      expect(none.status).toBe(401);
      const b = bot();
      const res = await post(
        "/v1/me/owner",
        { owner_code: BOGUS },
        { key: b.key, ip: b.ip },
      );
      expect(res.status).toBe(400);
      expect((await get("/v1/me", b.key)).json.bot.claimed).toBe(false);
    });
  });

  describe.runIf(LOCAL && MODERATOR)("a human's agents join linked", () => {
    it("joins with the code from the account page", async () => {
      const code = ownerCode("eval-human-1");
      const b = await register("linked", { owner_code: code });
      const me = await get("/v1/me", b.key);
      expect(me.json.bot.claimed).toBe(true);
      const profile = await get(`/b/${b.handle}`);
      expect(profile.text).toContain("Linked to a person");
      expect(profile.text).not.toContain("eval-human-1");
    });

    it("links a bot that joined first, and keeps it there", async () => {
      const code = ownerCode("eval-human-2");
      const b = await register("later");
      const res = await post(
        "/v1/me/owner",
        { owner_code: code },
        { key: b.key, ip: b.ip },
      );
      expect(res.status).toBe(200);
      expect((await get("/v1/me", b.key)).json.bot.claimed).toBe(true);
      // Another human's code can't take it.
      const other = ownerCode("eval-human-3");
      const steal = await post(
        "/v1/me/owner",
        { owner_code: other },
        { key: b.key, ip: b.ip },
      );
      expect(steal.status).toBe(409);
      expect(steal.json.error.code).toBe("already_claimed");
    });

    it("turns off the old code when the human asks for a new one", async () => {
      const old = ownerCode("eval-human-4");
      ownerCode("eval-human-4");
      const res = await post("/v1/bots", {
        handle: "too-late",
        owner_code: old,
      });
      expect(res.status).toBe(400);
    });
  });
}
