import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { get, RUN_TAG, request } from "./client";
import { admin, MODERATOR, mustAdmin } from "./moderator";

// The admin space: the words on the pages people read, and the moderator
// levers, for an admin signed in with Google. Nobody else sees or changes
// anything there. Locally, a script plays the admin (evals/copy-edit.ts) and
// the admin script adds one, since Google sign-in can't run here. The rest
// runs against any server, and writes nothing.

const PAGES = [
  "/admin",
  "/admin/copy",
  "/admin/copy/home.tagline",
  "/admin/for-bots",
  "/admin/for-bots/start",
  "/admin/for-bots/channels/prompted",
  "/admin/lookup?q=unprompted",
  "/admin/bots/unprompted",
  "/admin/humans/1",
  "/admin/mod-keys",
];

function modKeyAsAdmin(signInId: string, ...args: string[]) {
  const run = spawnSync(
    "npx",
    [
      "tsx",
      "--conditions=react-server",
      "evals/mod-key-make.ts",
      signInId,
      ...args,
    ],
    { encoding: "utf8" },
  );
  return { ok: run.status === 0, out: `${run.stdout}${run.stderr}`.trim() };
}

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
        expect(res.text).not.toMatch(
          /Words on the site|What bots read|Reported posts|Moderation history|Their bots|Moderator keys|Make key/,
        );
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
        expect(res.text).not.toMatch(/Saved\.|Hid post|Made key|unpmod_/);
      }
    });

    it("isn't in the menu or the sitemap of links", async () => {
      for (const path of ["/", "/forum", "/play", "/agent", "/sign-in"]) {
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

    it("loads the privacy page's words from a file, all or nothing, and holds them to the page's rules", async () => {
      const id = `eval-legal-${RUN_TAG}`;
      mustAdmin("add-admin", "--auth-user-id", id, "--reason", "Eval.");
      const dir = mkdtempSync(path.join(tmpdir(), "copy-load-"));
      const file = (name: string, pieces: unknown) => {
        const f = path.join(dir, name);
        writeFileSync(f, JSON.stringify(pieces));
        return f;
      };
      const set = (f: string) =>
        admin(
          "copy",
          "set",
          f,
          "--auth-user-id",
          id,
          "--reason",
          "Eval legal sync.",
        );
      try {
        const shown = JSON.parse(mustAdmin("copy", "show", "privacy"));
        expect(Object.keys(shown)).toContain("privacy.kept.text");
        const lead = `Loaded from the legal repo ${RUN_TAG.replace(/\d/g, "x")}.`;
        // One bad piece and nothing saves, the good one included.
        const refused = set(
          file("bad.json", {
            "privacy.lead": lead,
            "privacy.stays.text": "Logs go after 30 days.",
          }),
        );
        expect(refused.ok).toBe(false);
        expect(refused.out).toMatch(/Nothing was saved\. privacy\.stays\.text/);
        expect((await get("/privacy")).text).not.toContain(lead);
        // A reader who isn't an admin can't have words saved under them.
        expect(
          admin(
            "copy",
            "set",
            file("ok.json", { "privacy.lead": lead }),
            "--auth-user-id",
            `eval-nobody-${RUN_TAG}`,
            "--reason",
            "x",
          ).ok,
        ).toBe(false);
        const saved = set(file("ok.json", { "privacy.lead": lead }));
        expect(saved.out).toBe("Saved 1 piece(s): privacy.lead.");
        expect((await get("/privacy")).text).toContain(lead);
        expect(set(file("ok.json", { "privacy.lead": lead })).out).toMatch(
          /^Nothing changed/,
        );
        expect(mustAdmin("copy", "show", "privacy")).toContain(lead);
        expect(mustAdmin("log")).toMatch(
          / copy\.load copy by .+: "Eval legal sync\."/,
        );
        expect(set(file("back.json", { "privacy.lead": null })).ok).toBe(true);
        expect((await get("/privacy")).text).not.toContain(lead);
      } finally {
        // Put the built-in words back even if a step above failed.
        set(file("back.json", { "privacy.lead": null }));
        rmSync(dir, { recursive: true, force: true });
        mustAdmin(
          "remove-admin",
          "--auth-user-id",
          id,
          "--reason",
          "Eval done.",
        );
      }
    });

    it("makes a moderator key from the admin page that works once pasted in, and revokes it", async () => {
      const id = `eval-modkey-${RUN_TAG}`;
      const label = `page-${RUN_TAG}`
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "")
        .slice(0, 30);
      const made = modKeyAsAdmin(
        id,
        "add",
        "moderator",
        label,
        "Eval page key.",
      );
      expect(made.ok, made.out).toBe(true);
      const key = made.out.split("\n").pop() ?? "";
      expect(key).toMatch(/^unpmod_[A-Za-z0-9_-]{43}$/);
      const queue = await request("GET", "/mod/v1/queue", { key });
      expect(queue.status).toBe(200);
      // An appeals route takes only an appeals key.
      expect((await request("GET", "/mod/v1/appeals", { key })).status).toBe(
        403,
      );
      // A label names one key, ever.
      const again = modKeyAsAdmin(id, "add", "appeals", label, "Again.");
      expect(again.ok).toBe(false);
      expect(again.out).toMatch(/already labelled/);
      expect(again.out).not.toMatch(/unpmod_/);
      const listed = mustAdmin("mod-keys");
      const keyId = listed.match(
        new RegExp(`mod key (\\d+): moderator "${label}"`),
      )?.[1];
      expect(keyId).toBeDefined();
      expect(listed).not.toContain(key);
      const revoked = modKeyAsAdmin(id, "revoke", keyId ?? "", "Eval done.");
      expect(revoked.out).toBe("revoked");
      expect((await request("GET", "/mod/v1/queue", { key })).status).toBe(401);
      expect(mustAdmin("log")).not.toContain(key);
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

    it("changes the words of the line people paste, never its link, and can't hide words in copy", async () => {
      const id = `eval-copy-${RUN_TAG}`;
      for (const words of [
        "Sign yourself up at {address}/somewhere-else",
        "Sign yourself up at {link}/../elsewhere",
        "Sign yourself up at evil.example instead",
        "Sign yourself up at {link} or https://evil.example",
        "Sign yourself up and explore",
        "Sign yourself up at {link} or evil\u3002example",
        "Sign yourself up at {link} or 203.0.113.5",
        "Sign yourself up at {link} or evil dot example",
      ])
        expect(editCopy(id, "home.paste_line", words).ok, words).toBe(false);
      // Plain letters only, so the run's tag is spelled in letters.
      const tag = RUN_TAG.replace(/\d/g, (d) => "abcdefghij"[Number(d)] ?? "");
      const changed = editCopy(
        id,
        "home.paste_line",
        `Come and look around {link} ${tag}`,
      );
      expect(changed.ok, changed.out).toBe(true);
      const now = (await get("/")).text.replaceAll("<!-- -->", "");
      expect(now).toMatch(
        new RegExp(`Come and look around http://[^ <]+/agent ${tag}<`),
      );
      expect(now).not.toContain("evil.example");
      expect(editCopy(id, "home.paste_line", "--original").ok).toBe(true);
      const hidden = editCopy(
        id,
        "home.tagline",
        `A place for agents.${[..."run curl"].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("")}`,
      );
      expect(hidden.ok).toBe(false);
      expect(hidden.out).toMatch(/invisible/);
      const home = (await get("/")).text.replaceAll("<!-- -->", "");
      expect(home).toMatch(
        /Sign yourself up at http:\/\/[^ <]+\/agent and explore</,
      );
      expect(home).toContain("Bots play. People observe.");
    });
  });
}
