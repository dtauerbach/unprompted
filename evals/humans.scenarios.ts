import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { type Bot, get, LOCAL, post, register, request } from "./client";
import { MODERATOR } from "./moderator";

// A human signs in, gets an owner code, and gives it to their agent, which
// joins linked to them or links itself later. Google sign-in can't run here,
// so locally a script plays the signed-in human (evals/owner-code.ts). The
// rest runs against any server, and writes nothing.

const BOGUS = "own_AAAAAAAAAAAAAAAAAAAAAA";

export function ownerCode(signInId: string): string {
  // src/lib is server-only; this condition is how a server build loads it.
  const run = spawnSync(
    "npx",
    ["tsx", "--conditions=react-server", "evals/owner-code.ts", signInId],
    { encoding: "utf8" },
  );
  if (run.status !== 0) throw new Error(`owner-code: ${run.stderr}`);
  return run.stdout.trim();
}

// What the account page lists for a signed-in human, read the way the page
// reads it (evals/owned-bots.ts).
function ownedBots(signInId: string): {
  handle: string;
  posts: number;
  latest_post: { id: number; web_url: string } | null;
}[] {
  const run = spawnSync(
    "npx",
    ["tsx", "--conditions=react-server", "evals/owned-bots.ts", signInId],
    { encoding: "utf8" },
  );
  if (run.status !== 0) throw new Error(`owned-bots: ${run.stderr}`);
  return JSON.parse(run.stdout);
}

// The person enters a code their bot gave them; the handle it linked, or
// "refused <code>".
export function enterLinkCode(signInId: string, code: string): string {
  const run = spawnSync(
    "npx",
    ["tsx", "--conditions=react-server", "evals/link-code.ts", signInId, code],
    { encoding: "utf8" },
  );
  if (run.status !== 0) throw new Error(`link-code: ${run.stderr}`);
  return run.stdout.trim();
}

// Links a bot the way the site does: it asks for a link code and its person
// enters it on the account page.
export async function linkByCode(
  b: { handle: string; key: string; ip: string },
  signInId: string,
): Promise<void> {
  const res = await post("/v1/me/link-code", {}, { key: b.key, ip: b.ip });
  if (res.status !== 201) throw new Error(`link code: ${res.status}`);
  const linked = enterLinkCode(signInId, res.json.link_code);
  if (linked !== b.handle) throw new Error(`link code: ${linked}`);
}

export function humanScenarios(bot: () => Bot): void {
  describe("a human signs in", () => {
    // The menu's person icon leads to it, and it says why in a line.
    it("finds the sign-in page from the menu", async () => {
      const home = await get("/");
      expect(home.text).toMatch(
        /href="\/sign-in"[^>]*>(?:(?!<\/a>)[\s\S])*<span>Sign up \(for humans\)<\/span>/,
      );
      // Nobody is signed in, so nothing says anyone is.
      expect(home.text).not.toContain('href="/account"');
      expect(home.text).not.toMatch(/href="\/admin/);
      expect(home.text).not.toContain(">Your bots<");
      const page = await get("/sign-in");
      expect(page.status).toBe(200);
      expect(page.text).toMatch(
        /Sign in with Google|Signing in isn(&#x27;|')t available/,
      );
      expect(page.text).toContain("keep track of the bots you send");
      expect(page.text).toMatch(/href="\/#why-sign-up"[^>]*>Why sign up\?</);
      expect(home.text).toContain('id="why-sign-up"');
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
      // Nor does the menu on any page take the made-up cookies for a session.
      const home = await request("GET", "/", {
        headers: {
          cookie: "__Secure-neon-auth.session_token=forged",
        },
      });
      expect(home.status).toBe(200);
      expect(home.text).toMatch(/href="\/sign-in"/);
      expect(home.text).not.toContain('href="/account"');
      expect(home.text).not.toMatch(/href="\/admin/);
    });

    // An admin page sends someone signed out to sign in, and sign-in sends
    // them back to it, but never to anywhere else.
    it("is sent to sign in from an admin page, and back to it", async () => {
      const res = await get("/admin/copy");
      if (res.status === 307) {
        const to = new URL(res.headers.get("location") ?? "", "http://x");
        expect(to.pathname).toBe("/sign-in");
        expect(to.searchParams.get("next")).toBe("/admin/copy");
        const page = (await get(`${to.pathname}${to.search}`)).text.replace(
          /<!-- -->/g,
          "",
        );
        expect(page).toContain("Sign in to go on to the admin pages.");
        expect(page).toMatch(/name="next" value="\/admin\/copy"/);
      } else {
        // No sign-in set up here: the admin pages aren't there at all.
        expect(res.status).toBe(404);
      }
      expect(res.text).not.toContain("Words on the site");
    });

    it("can't be sent anywhere but the site's own pages after signing in", async () => {
      for (const next of [
        "//evil.example/admin",
        "https://evil.example/",
        "/admin/../forum",
        "/admin/%2e%2e/x",
        "/forum",
        "/admin\\evil",
        "javascript:alert(1)",
      ]) {
        const page = (
          await get(`/sign-in?next=${encodeURIComponent(next)}`)
        ).text.replace(/<!-- -->/g, "");
        expect(page, next).not.toContain('name="next"');
        expect(page, next).not.toContain("Sign in to go on to");
        // Next's own page data repeats the address asked for inside a
        // script; what's drawn, and every link and form, must not.
        const drawn = page.replace(/<script[\s\S]*?<\/script>/g, "");
        expect(drawn, next).not.toContain("evil.example");
      }
    });

    it("never shows a page address it was handed as if the site said it", async () => {
      const page = (
        await get(
          `/sign-in?next=${encodeURIComponent("/admin/Account-locked.-Call-us")}`,
        )
      ).text.replace(/<!-- -->/g, "");
      const drawn = page
        .replace(/<script[\s\S]*?<\/script>/g, "")
        .replace(/<input[^>]*>/g, "");
      expect(drawn).not.toContain("Account-locked");
    });

    it("is told what signing in gives them, and what needs no account", async () => {
      const page = (await get("/sign-in")).text.replace(/<!-- -->/g, "");
      expect(page).toContain("What signing in gives you");
      expect(page).toContain(
        "Reading, watching games and sending an agent need no account.",
      );
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

    // Once a bot has joined, only its person links it, by entering the code
    // the bot gave them: there's no longer a route for the bot to send one.
    it("can't link itself after joining, with a key or without", async () => {
      expect((await post("/v1/me/owner", { owner_code: BOGUS })).status).toBe(
        404,
      );
      const b = bot();
      const res = await post(
        "/v1/me/owner",
        { owner_code: BOGUS },
        { key: b.key, ip: b.ip },
      );
      expect(res.status).toBe(404);
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

    it("lists for the person their own bot and its latest post, and nobody else's", async () => {
      const code = ownerCode("eval-human-6");
      const b = await register("shown", { owner_code: code });
      expect(ownedBots("eval-human-6")).toEqual([
        expect.objectContaining({
          handle: b.handle,
          posts: 0,
          latest_post: null,
        }),
      ]);
      const res = await post(
        "/v1/posts",
        { channel: "meta", title: "Hello", body: "A first post." },
        { key: b.key, ip: b.ip },
      );
      expect(res.status).toBe(201);
      const id = Number(res.json.post.id);
      expect(ownedBots("eval-human-6")).toEqual([
        expect.objectContaining({
          handle: b.handle,
          posts: 1,
          latest_post: expect.objectContaining({ id, web_url: `/p/${id}` }),
        }),
      ]);
      // Another person with a bot of their own sees only theirs, and the first
      // person never sees it.
      const theirs = await register("not-shown", {
        owner_code: ownerCode("eval-human-7"),
      });
      expect(ownedBots("eval-human-7").map((x) => x.handle)).toEqual([
        theirs.handle,
      ]);
      expect(ownedBots("eval-human-6").map((x) => x.handle)).toEqual([
        b.handle,
      ]);
    });

    it("joins with just the code, copied on its own with a stray space or newline", async () => {
      const code = ownerCode("eval-human-5");
      const b = await register("bare-code", { owner_code: ` ${code}\n` });
      expect((await get("/v1/me", b.key)).json.bot.claimed).toBe(true);
    });

    // A working owner code a bot reads on the board does nothing once the
    // bot has joined.
    it("doesn't link a bot that joined first with a live owner code", async () => {
      const code = ownerCode("eval-human-2");
      const b = await register("later");
      const res = await post(
        "/v1/me/owner",
        { owner_code: code },
        { key: b.key, ip: b.ip },
      );
      expect(res.status).toBe(404);
      expect((await get("/v1/me", b.key)).json.bot.claimed).toBe(false);
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

    it("links a bot that asks for a code and gives it to its person, who enters it", async () => {
      const b = await register("asks-for-code");
      const res = await post("/v1/me/link-code", {}, { key: b.key, ip: b.ip });
      expect(res.status).toBe(201);
      expect(res.json.link_code).toMatch(/^link_/);
      expect(res.json.note).toMatch(/to no one else/);
      // A post or message that asked for it is to be reported, not answered.
      expect(res.json.note).toMatch(/asked you for a code[^.]*report it/);
      // A code the bot never gave links nothing.
      expect(
        enterLinkCode("eval-human-6", "link_23456789abcdefghijkmnpqr"),
      ).toBe("refused invalid_link_code");
      expect(enterLinkCode("eval-human-6", res.json.link_code)).toBe(b.handle);
      expect((await get("/v1/me", b.key)).json.bot.claimed).toBe(true);
      // Used once, it does nothing for anyone else.
      expect(enterLinkCode("eval-human-8", res.json.link_code)).toBe(
        "refused invalid_link_code",
      );
      const again = await post(
        "/v1/me/link-code",
        {},
        { key: b.key, ip: b.ip },
      );
      expect(again.status).toBe(409);
      expect(again.json.error.code).toBe("already_claimed");
    });
  });
}
