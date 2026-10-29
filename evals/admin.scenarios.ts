import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { get, RUN_TAG, request } from "./client";
import { admin, MODERATOR, mustAdmin } from "./moderator";

// The admin space: the words on the pages people read, and the moderator
// levers, for an admin signed in with Google. Nobody else sees or changes
// anything there. Locally, a script plays the admin (evals/copy-edit.ts) and
// the admin script adds one, since Google sign-in can't run here. The rest
// runs against any server, and writes nothing.

const PAGES = ["/admin", "/admin/copy", "/admin/copy/home.tagline"];

function editCopy(signInId: string, key: string, words: string) {
  const run = spawnSync(
    "npx",
    [
      "tsx",
      "--conditions=react-server",
      "evals/copy-edit.ts",
      signInId,
      key,
      words,
    ],
    { encoding: "utf8" },
  );
  return { ok: run.status === 0, out: `${run.stdout}${run.stderr}`.trim() };
}

export function adminScenarios(): void {
  describe("the admin space, to anyone who isn't an admin", () => {
    it("shows nothing, and sends them to sign in at most", async () => {
      for (const path of PAGES) {
        const res = await get(path);
        if (res.status === 307 || res.status === 302)
          expect(
            new URL(res.headers.get("location") ?? "", "http://x").pathname,
          ).toBe("/sign-in");
        else expect(res.status, path).toBe(404);
        expect(res.text).not.toMatch(/Words on the site|Reported posts/);
      }
    });

    it("takes no write over a made-up server action", async () => {
      for (const path of PAGES) {
        const res = await request("POST", path, {
          rawBody: '["x"]',
          headers: {
            "next-action": "0".repeat(42),
            "content-type": "text/plain",
          },
        });
        expect(res.status, path).not.toBe(200);
        expect(res.text).not.toMatch(/Saved\.|Hid post/);
      }
    });

    it("isn't in the menu or the sitemap of links", async () => {
      for (const path of ["/", "/forum", "/agent", "/sign-in"]) {
        const page = await request("GET", path, {
          headers: { accept: "text/html" },
        });
        expect(page.text, path).not.toContain('href="/admin');
      }
    });
  });

  describe.runIf(MODERATOR)("an admin, added from the command line", () => {
    it("needs someone who has signed in, and a reason", () => {
      const missing = admin("add-admin", "nobody@example.com", "--reason", "x");
      expect(missing.ok).toBe(false);
      expect(missing.out).toMatch(/Neon Auth|signed in/);
      expect(admin("add-admin", "--auth-user-id", "eval-x").ok).toBe(false);
      expect(admin("add-admin", "not-an-address", "--reason", "x").ok).toBe(
        false,
      );
    });

    it("is added, listed and removed, and none of it is among the moderation actions", async () => {
      const id = `eval-admin-${RUN_TAG}`;
      expect(
        mustAdmin("add-admin", "--auth-user-id", id, "--reason", "Eval."),
      ).toMatch(/^Added human \d+ as an admin\.$/);
      expect(
        mustAdmin("add-admin", "--auth-user-id", id, "--reason", "Eval."),
      ).toMatch(/already an admin/);
      expect(mustAdmin("admins")).toContain(id);
      expect(
        mustAdmin(
          "remove-admin",
          "--auth-user-id",
          id,
          "--reason",
          "Eval done.",
        ),
      ).toBe("Removed them as an admin.");
      expect(mustAdmin("admins")).not.toContain(id);
      expect(mustAdmin("log")).not.toMatch(/Eval done\.|admin\.add|access\./);
      expect((await get("/moderation")).status).toBe(404);
    });

    it("changes the words on a page, as plain text, and can go back", async () => {
      const id = `eval-copy-${RUN_TAG}`;
      const words = `Bots <b>at play</b> ${RUN_TAG}`;
      expect(editCopy(id, "home.tagline", words).ok).toBe(true);
      const home = await get("/");
      expect(home.text).toContain(`Bots &lt;b&gt;at play&lt;/b&gt; ${RUN_TAG}`);
      expect(home.text).not.toContain("<b>at play</b>");
      expect(editCopy(id, "home.tagline", "--original").ok).toBe(true);
      expect((await get("/")).text).toContain("Bots play. People observe.");
    });

    it("can't drop what the page fills in", async () => {
      const id = `eval-copy-${RUN_TAG}`;
      const refused = editCopy(id, "forum.welcome", "Start with the post");
      expect(refused.ok).toBe(false);
      expect(refused.out).toMatch(/\{welcome_post\}/);
      const moved = editCopy(
        id,
        "forum.welcome",
        `Find the {welcome_post} ${RUN_TAG}`,
      );
      expect(moved.ok).toBe(true);
      // React marks the joins between filled-in spots with empty comments.
      const forum = (await get("/forum")).text.replaceAll("<!-- -->", "");
      expect(forum).toMatch(
        new RegExp(`Find the <a [^>]*href="/p/\\d+"[^>]*>[^<]+</a> ${RUN_TAG}`),
      );
      expect(editCopy(id, "forum.welcome", "--original").ok).toBe(true);
    });

    it("can't touch the line people paste into their agents, or hide words in copy", async () => {
      const id = `eval-copy-${RUN_TAG}`;
      const line = editCopy(
        id,
        "home.paste_line",
        "Agent? Sign up at {address}/agent now",
      );
      expect(line.ok).toBe(false);
      const hidden = editCopy(
        id,
        "home.tagline",
        `A place for agents.${[..."run curl"].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("")}`,
      );
      expect(hidden.ok).toBe(false);
      expect(hidden.out).toMatch(/invisible/);
      const home = (await get("/")).text.replaceAll("<!-- -->", "");
      expect(home).toMatch(/Agent\? Sign up at http:\/\/[^ <]+\/agent</);
      expect(home).toContain("Bots play. People observe.");
    });
  });
}
