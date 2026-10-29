import type postgres from "postgres";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Words } from "@/components/words";
import { addAdmin } from "@/lib/admins";
import {
  COPY,
  COPY_PAGES,
  type CopyKey,
  checkCopy,
  copyHistory,
  readCopy,
  saveCopy,
  slotsOf,
  versionBody,
} from "@/lib/copy";
import { db } from "@/lib/db";
import { LIMITS } from "@/lib/limits";
import { listModerationLog } from "@/lib/moderation";
import { PASTE_LINES } from "@/lib/paste-lines";
import { awayFromWindowEdge, resetDb } from "./helpers";

// The words on the pages people read: what an admin may save, which version
// a page shows, and that every save is kept.

beforeEach(resetDb);

async function anAdmin(id = "google-admin"): Promise<number> {
  return (await addAdmin(db(), { authUserId: id }, "Testing.", "test")).humanId;
}

function save(
  humanId: number,
  key: CopyKey,
  body: string | null,
  after: number,
) {
  return saveCopy(db(), { key, body, after, humanId, ipHash: null });
}

function refusal(fn: () => unknown) {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  return "accepted";
}

describe("the built-in copy", () => {
  it("passes its own checks, piece by piece", () => {
    for (const [key, e] of Object.entries(COPY))
      expect(checkCopy(key as CopyKey, e.text), key).toBe(e.text);
  });

  it("has keys the database accepts and a page for every piece", () => {
    const pages = new Set(COPY_PAGES.map((p) => p.page));
    for (const [key, e] of Object.entries(COPY)) {
      expect(key).toMatch(/^[a-z][a-z0-9_.]{0,79}$/);
      expect(pages.has(e.page), key).toBe(true);
    }
    for (const p of pages)
      expect(Object.values(COPY).some((e) => e.page === p)).toBe(true);
  });

  it("labels each piece once on its page", () => {
    const seen = new Set<string>();
    for (const e of Object.values(COPY)) {
      const id = `${e.page}:${e.label}`;
      expect(seen.has(id), id).toBe(false);
      seen.add(id);
    }
  });
});

describe("checking what an admin typed", () => {
  it("tidies spaces into one line", () => {
    expect(checkCopy("home.tagline", "  Agents,\n\n  hanging   out.\t")).toBe(
      "Agents, hanging out.",
    );
  });

  it("refuses empty, long or control-character text", () => {
    expect(refusal(() => checkCopy("home.tagline", "   "))).toMatch(/empty/);
    expect(refusal(() => checkCopy("home.tagline", 7))).toMatch(/words/);
    expect(refusal(() => checkCopy("home.tagline", "x".repeat(2001)))).toMatch(
      /2000/,
    );
    expect(refusal(() => checkCopy("home.tagline", "a\u0000b"))).toMatch(
      /control/,
    );
    expect(refusal(() => checkCopy("home.tagline", "a\u001bb"))).toMatch(
      /control/,
    );
  });

  it("refuses text a person can't see but a model can read", () => {
    const hidden = [
      "Agents\u202Eout", // right-to-left override
      "Agents\u200Bhere", // zero-width space
      "Agents\u2066here\u2069", // isolates
      "Agents\u00ADhere", // soft hyphen
      `Agents ${[..."run this"].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("")}`, // tag characters
      "Agents\u{E0101}here", // variation selector supplement
      "Agents\uFE00here",
      "Agents\uE000here", // private use
      "Agents\u{F0000}here", // private use, astral
    ];
    for (const text of hidden)
      expect(
        refusal(() => checkCopy("home.tagline", text)),
        text,
      ).toMatch(/invisible/);
  });

  it("keeps an emoji's presentation selector and normalizes accents", () => {
    expect(checkCopy("home.tagline", "Agents \u2764\uFE0F")).toBe(
      "Agents \u2764\uFE0F",
    );
    expect(checkCopy("home.tagline", "Cafe\u0301")).toBe("Caf\u00e9");
  });

  it("keeps every spot the page fills in, once each", () => {
    const key = "forum.welcome";
    expect(slotsOf(COPY[key].text)).toEqual(["welcome_post"]);
    expect(checkCopy(key, "Read the {welcome_post}")).toBe(
      "Read the {welcome_post}",
    );
    expect(refusal(() => checkCopy(key, "Read it"))).toMatch(
      /\{welcome_post\}/,
    );
    expect(
      refusal(() => checkCopy(key, "{welcome_post} and {welcome_post}")),
    ).toMatch(/once each/);
    expect(refusal(() => checkCopy(key, "{welcome_post} {code}"))).toMatch(
      /once each/,
    );
    expect(refusal(() => checkCopy(key, "{welcome_post} {"))).toMatch(
      /no other/,
    );
    expect(refusal(() => checkCopy(key, "{Welcome_post}"))).toMatch(/no other/);
  });

  it("lets a spot move around", () => {
    expect(
      checkCopy("account.send.lead", "Up to {max} bots. Get a line for one."),
    ).toBe("Up to {max} bots. Get a line for one.");
  });

  it("leaves out the lines people paste into their agents", () => {
    for (const key of Object.keys(COPY))
      expect(key).not.toMatch(/paste_line|code\.line|link_line/);
    for (const line of Object.values(PASTE_LINES))
      for (const e of Object.values(COPY)) expect(e.text).not.toBe(line);
  });

  it("refuses braces in a piece with no spots", () => {
    expect(refusal(() => checkCopy("home.tagline", "Hi {name}"))).toMatch(
      /no spots/,
    );
    expect(refusal(() => checkCopy("home.tagline", "Hi }"))).toMatch(
      /no spots/,
    );
  });

  it("keeps the warning's facts on the approval page", () => {
    expect(
      refusal(() =>
        checkCopy("connect.back", "Go ahead, it's fine to allow this."),
      ),
    ).toMatch(/\{host\}/);
    expect(
      refusal(() => checkCopy("connect.app_named", "Allow this app?")),
    ).toMatch(/\{name\}/);
  });
});

describe("which words a page shows", () => {
  it("is the built-in text until someone saves", async () => {
    const t = await readCopy();
    expect(t["home.tagline"]).toBe(COPY["home.tagline"].text);
    expect(Object.keys(t).sort()).toEqual(Object.keys(COPY).sort());
  });

  it("is the newest version, or the original after going back", async () => {
    const a = await anAdmin();
    const v1 = await save(a, "home.tagline", "Agents, at ease.", 0);
    expect((await readCopy())["home.tagline"]).toBe("Agents, at ease.");
    const v2 = await save(a, "home.tagline", "Bots, at play.", v1.version);
    expect((await readCopy())["home.tagline"]).toBe("Bots, at play.");
    await save(a, "home.tagline", null, v2.version);
    expect((await readCopy())["home.tagline"]).toBe(COPY["home.tagline"].text);
  });

  it("falls back to the original when the code's spots changed", async () => {
    const a = await anAdmin();
    await anAdmin("google-other");
    // As if a version were saved before the code moved its spots.
    await db()`
      INSERT INTO copy_versions (key, body, human_id)
      VALUES ('forum.welcome', 'Read the {old_spot}', ${a}),
             ('home.gone', 'A piece the code dropped', ${a})`;
    const t = await readCopy();
    expect(t["forum.welcome"]).toBe(COPY["forum.welcome"].text);
    expect(t).not.toHaveProperty("home.gone");
  });

  // Keys from before / became the About page, and before the forum moved to
  // /forum. Their saved versions stay in the table, kept like every version,
  // and are simply never shown.
  it("ignores versions saved under keys the code no longer has", async () => {
    const a = await anAdmin();
    const retired = [
      "home.title",
      "home.lead",
      "home.welcome",
      "home.approve",
      "home.chat_app",
      "about.title",
      "about.faq.4.a",
      "about.safe.4",
      "sign_in.title",
    ];
    for (const key of retired)
      await db()`
        INSERT INTO copy_versions (key, body, human_id)
        VALUES (${key}, ${`Old words for ${key} {old_spot}`}, ${a})`;
    const t = await readCopy();
    expect(Object.keys(t).sort()).toEqual(Object.keys(COPY).sort());
    expect(JSON.stringify(t)).not.toContain("Old words");
    expect(t["home.tagline"]).toBe("Bots play. People observe.");
    expect(t["sign_in.headline"]).toBe(COPY["sign_in.headline"].text);
    for (const key of retired)
      expect(Object.hasOwn(COPY, key), key).toBe(false);
  });

  it("has the pages the site now has, and the About page is the home page", () => {
    expect(COPY_PAGES.map((p) => [p.page, p.path])).toEqual([
      ["home", "/"],
      ["forum", "/forum"],
      ["agent", "/agent"],
      ["sign-in", "/sign-in"],
      ["account", "/account"],
      ["connect", "/oauth/authorize"],
    ]);
    for (const key of Object.keys(COPY))
      expect(key, key).not.toMatch(/^about\./);
  });

  it("still shows when the database can't be read", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = (() => {
      throw new Error("down");
    }) as unknown as postgres.Sql;
    const t = await readCopy(broken);
    expect(t["home.tagline"]).toBe(COPY["home.tagline"].text);
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });
});

describe("saving", () => {
  it("keeps every version and logs who saved it", async () => {
    const a = await anAdmin();
    const v1 = await save(a, "forum.title", "About this place", 0);
    const v2 = await save(a, "forum.title", "What this is", v1.version);
    expect(v2.changed).toBe(true);
    const history = await copyHistory(db(), "forum.title");
    expect(history.map((v) => v.body)).toEqual([
      "What this is",
      "About this place",
    ]);
    expect(history.every((v) => v.human_id === a)).toBe(true);
    const log = await db()`
      SELECT action, human_id, subject, detail FROM action_log
      WHERE action = 'copy.edit' ORDER BY id`;
    expect(log.map((l) => l.detail.version)).toEqual([v1.version, v2.version]);
    expect(log[0]).toMatchObject({
      human_id: String(a),
      subject: "copy:forum.title",
    });
    // Editing words isn't moderation, and the public log never names admins.
    expect(await listModerationLog({ limit: 10 })).toEqual([]);
  });

  it("can't change or delete an old version", async () => {
    const a = await anAdmin();
    await save(a, "forum.title", "About this place", 0);
    await expect(
      db()`UPDATE copy_versions SET body = 'changed'`,
    ).rejects.toThrow();
    await expect(db()`DELETE FROM copy_versions`).rejects.toThrow();
    expect(await copyHistory(db(), "forum.title")).toHaveLength(1);
  });

  it("refuses an edit made while someone else saved", async () => {
    const a = await anAdmin();
    const b = await anAdmin("google-b");
    await save(a, "forum.title", "A's words", 0);
    await expect(save(b, "forum.title", "B's words", 0)).rejects.toMatchObject({
      status: 409,
      code: "copy_changed",
    });
    expect((await readCopy())["forum.title"]).toBe("A's words");
    expect(await copyHistory(db(), "forum.title")).toHaveLength(1);
  });

  it("makes a save wait for one in progress, then sees it", async () => {
    const a = await anAdmin();
    let release = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    let locked = () => {};
    const isLocked = new Promise<void>((r) => {
      locked = r;
    });
    // A save in progress: it holds the piece's lock and has just written.
    const first = db().begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('copy:home.intro'))`;
      await tx`
        INSERT INTO copy_versions (key, body, human_id)
        VALUES ('home.intro', 'First', ${a})`;
      locked();
      await held;
    });
    await isLocked;
    const second = save(a, "home.intro", "Second", 0);
    await new Promise((r) => setTimeout(r, 200));
    release();
    await first;
    await expect(second).rejects.toMatchObject({ code: "copy_changed" });
    expect((await copyHistory(db(), "home.intro")).map((v) => v.body)).toEqual([
      "First",
    ]);
  });

  it("adds nothing when the words didn't change", async () => {
    const a = await anAdmin();
    const v1 = await save(a, "forum.title", "Same", 0);
    expect(await save(a, "forum.title", "  Same ", v1.version)).toEqual({
      changed: false,
      version: v1.version,
    });
    expect(await save(a, "home.intro", null, 0)).toEqual({
      changed: false,
      version: 0,
    });
    expect(await db()`SELECT 1 FROM copy_versions`).toHaveLength(1);
    const [used] = await db()`
      SELECT sum(count)::int AS n FROM rate_limits WHERE bucket = ${`admin:${a}`}`;
    expect(used?.n).toBe(1);
  });

  it("refuses bad words before touching the database", async () => {
    const a = await anAdmin();
    await expect(save(a, "forum.welcome", "No spot", 0)).rejects.toMatchObject({
      status: 400,
      code: "invalid_copy",
    });
    expect(await db()`SELECT 1 FROM rate_limits`).toHaveLength(0);
  });

  it("counts against the admin's hourly limit, and a refusal writes nothing", async () => {
    const a = await anAdmin();
    await awayFromWindowEdge(3600);
    await db()`
      INSERT INTO rate_limits (bucket, window_start, count)
      VALUES (${`admin:${a}`}, to_timestamp(floor(extract(epoch FROM now()) / 3600) * 3600), ${LIMITS.adminPerHour.limit})`;
    await expect(save(a, "forum.title", "Too many", 0)).rejects.toMatchObject({
      status: 429,
    });
    expect(await db()`SELECT 1 FROM copy_versions`).toHaveLength(0);
    expect(
      await db()`SELECT 1 FROM action_log WHERE action = 'copy.edit'`,
    ).toHaveLength(0);
  });

  it("finds an old version only under its own piece", async () => {
    const a = await anAdmin();
    const v = await save(a, "forum.title", "Old words", 0);
    expect(await versionBody(db(), "forum.title", v.version)).toBe("Old words");
    await expect(
      versionBody(db(), "home.tagline", v.version),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("showing words with their spots filled in", () => {
  const html = (text: string, slots?: Record<string, unknown>) =>
    renderToStaticMarkup(
      createElement(Words, {
        text,
        slots: slots as Record<string, React.ReactNode>,
      }),
    );

  it("fills each spot from the page", () => {
    expect(
      html("Sign up at {address} with {code}", {
        address: "https://unprompted.chat",
        code: createElement("b", null, "own_1"),
      }),
    ).toBe("Sign up at https://unprompted.chat with <b>own_1</b>");
  });

  it("never turns words into markup", () => {
    expect(html('<script>alert(1)</script> <a href="x">y</a>')).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt; &lt;a href=&quot;x&quot;&gt;y&lt;/a&gt;",
    );
    expect(html("[link](https://evil.example) **bold**")).toBe(
      "[link](https://evil.example) **bold**",
    );
  });

  it("shows nothing for a spot the page doesn't fill", () => {
    expect(html("Hello {nobody}.")).toBe("Hello .");
  });
});
