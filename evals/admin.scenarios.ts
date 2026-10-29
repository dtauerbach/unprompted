import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { get, RUN_TAG, request } from "./client";
import { admin, MODERATOR, mustAdmin } from "./moderator";

// The admin space: the words on the pages people read, and the moderator
// levers, for an admin signed in with Google. Nobody else sees or changes
// anything there. Locally, a script plays the admin (evals/copy-edit.ts) and
// the admin script adds one, since Google sign-in can't run here. The rest
// runs against any server, and writes nothing.

const PAGES = ["/admin", "/admin/copy", "/admin/copy/home.title"];

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
      const home = await get("/");
      expect(home.text).not.toContain('href="/admin');
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

    it("is added, listed and removed, and none of it is on the public log", async () => {
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
      const log = await get("/moderation");
      expect(log.text).not.toMatch(/Eval done\.|admin\.add|access\./);
    });

    it("changes the words on a page, as plain text, and can go back", async () => {
      const id = `eval-copy-${RUN_TAG}`;
      const words = `Bots <b>at play</b> ${RUN_TAG}`;
      expect(editCopy(id, "home.title", words).ok).toBe(true);
      const home = await get("/");
      expect(home.text).toContain(`Bots &lt;b&gt;at play&lt;/b&gt; ${RUN_TAG}`);
      expect(home.text).not.toContain("<b>at play</b>");
      expect(editCopy(id, "home.title", "--original").ok).toBe(true);
      expect((await get("/")).text).toContain(
        "A place for AI agents to hang out.",
      );
    });

    it("can't drop what the page fills in", async () => {
      const id = `eval-copy-${RUN_TAG}`;
      const refused = editCopy(
        id,
        "home.paste_line",
        "Sign yourself up somewhere",
      );
      expect(refused.ok).toBe(false);
      expect(refused.out).toMatch(/\{address\}/);
      const moved = editCopy(
        id,
        "home.paste_line",
        `Join at {address} ${RUN_TAG}`,
      );
      expect(moved.ok).toBe(true);
      // React marks the joins between filled-in spots with empty comments.
      const home = (await get("/")).text.replaceAll("<!-- -->", "");
      expect(home).toMatch(new RegExp(`Join at http://[^ <]+ ${RUN_TAG}`));
      expect(editCopy(id, "home.paste_line", "--original").ok).toBe(true);
    });
  });
}
