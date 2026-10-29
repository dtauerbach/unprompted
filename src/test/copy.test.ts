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
    expect(checkCopy("home.title", "  Agents,\n\n  hanging   out.\t")).toBe(
      "Agents, hanging out.",
    );
  });

  it("refuses empty, long or control-character text", () => {
    expect(refusal(() => checkCopy("home.title", "   "))).toMatch(/empty/);
    expect(refusal(() => checkCopy("home.title", 7))).toMatch(/words/);
    expect(refusal(() => checkCopy("home.title", "x".repeat(2001)))).toMatch(
      /2000/,
    );
    expect(refusal(() => checkCopy("home.title", "a\u0000b"))).toMatch(
      /control/,
    );
    expect(refusal(() => checkCopy("home.title", "a\u001bb"))).toMatch(
      /control/,
    );
  });

  it("keeps every spot the page fills in, once each", () => {
    const key = "home.paste_line";
    expect(slotsOf(COPY[key].text)).toEqual(["address"]);
    expect(checkCopy(key, "Join us at {address}")).toBe("Join us at {address}");
    expect(refusal(() => checkCopy(key, "Join us"))).toMatch(/\{address\}/);
    expect(refusal(() => checkCopy(key, "{address} and {address}"))).toMatch(
      /once each/,
    );
    expect(refusal(() => checkCopy(key, "{address} {code}"))).toMatch(
      /once each/,
    );
    expect(refusal(() => checkCopy(key, "{address} {"))).toMatch(/no other/);
    expect(refusal(() => checkCopy(key, "{Address}"))).toMatch(/no other/);
  });

  it("lets spots move around", () => {
    expect(
      checkCopy(
        "account.code.line",
        "Owner code {code}: sign yourself up at {address}",
      ),
    ).toBe("Owner code {code}: sign yourself up at {address}");
  });

  it("refuses braces in a piece with no spots", () => {
    expect(refusal(() => checkCopy("home.title", "Hi {name}"))).toMatch(
      /no spots/,
    );
    expect(refusal(() => checkCopy("home.title", "Hi }"))).toMatch(/no spots/);
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
    expect(t["home.title"]).toBe(COPY["home.title"].text);
    expect(Object.keys(t).sort()).toEqual(Object.keys(COPY).sort());
  });

  it("is the newest version, or the original after going back", async () => {
    const a = await anAdmin();
    const v1 = await save(a, "home.title", "Agents, at ease.", 0);
    expect((await readCopy())["home.title"]).toBe("Agents, at ease.");
    const v2 = await save(a, "home.title", "Bots, at play.", v1.version);
    expect((await readCopy())["home.title"]).toBe("Bots, at play.");
    await save(a, "home.title", null, v2.version);
    expect((await readCopy())["home.title"]).toBe(COPY["home.title"].text);
  });

  it("falls back to the original when the code's spots changed", async () => {
    const a = await anAdmin();
    await anAdmin("google-other");
    // As if a version were saved before the code moved its spots.
    await db()`
      INSERT INTO copy_versions (key, body, human_id)
      VALUES ('home.paste_line', 'Come to {old_spot}', ${a}),
             ('home.gone', 'A piece the code dropped', ${a})`;
    const t = await readCopy();
    expect(t["home.paste_line"]).toBe(COPY["home.paste_line"].text);
    expect(t).not.toHaveProperty("home.gone");
  });

  it("still shows when the database can't be read", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = (() => {
      throw new Error("down");
    }) as unknown as postgres.Sql;
    const t = await readCopy(broken);
    expect(t["home.title"]).toBe(COPY["home.title"].text);
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });
});

describe("saving", () => {
  it("keeps every version and logs who saved it", async () => {
    const a = await anAdmin();
    const v1 = await save(a, "about.title", "About this place", 0);
    const v2 = await save(a, "about.title", "What this is", v1.version);
    expect(v2.changed).toBe(true);
    const history = await copyHistory(db(), "about.title");
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
      subject: "copy:about.title",
    });
  });

  it("can't change or delete an old version", async () => {
    const a = await anAdmin();
    await save(a, "about.title", "About this place", 0);
    await expect(
      db()`UPDATE copy_versions SET body = 'changed'`,
    ).rejects.toThrow();
    await expect(db()`DELETE FROM copy_versions`).rejects.toThrow();
    expect(await copyHistory(db(), "about.title")).toHaveLength(1);
  });

  it("refuses an edit made while someone else saved", async () => {
    const a = await anAdmin();
    const b = await anAdmin("google-b");
    await save(a, "about.title", "A's words", 0);
    await expect(save(b, "about.title", "B's words", 0)).rejects.toMatchObject({
      status: 409,
      code: "copy_changed",
    });
    expect((await readCopy())["about.title"]).toBe("A's words");
    expect(await copyHistory(db(), "about.title")).toHaveLength(1);
  });

  it("lets only one of two saves at once through", async () => {
    const a = await anAdmin();
    const results = await Promise.allSettled([
      save(a, "about.lead", "First", 0),
      save(a, "about.lead", "Second", 0),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await copyHistory(db(), "about.lead")).toHaveLength(1);
  });

  it("adds nothing when the words didn't change", async () => {
    const a = await anAdmin();
    const v1 = await save(a, "about.title", "Same", 0);
    expect(await save(a, "about.title", "  Same ", v1.version)).toEqual({
      changed: false,
      version: v1.version,
    });
    expect(await save(a, "about.lead", null, 0)).toEqual({
      changed: false,
      version: 0,
    });
    expect(await db()`SELECT 1 FROM copy_versions`).toHaveLength(1);
  });

  it("refuses bad words before touching the database", async () => {
    const a = await anAdmin();
    await expect(
      save(a, "home.paste_line", "No spot", 0),
    ).rejects.toMatchObject({ status: 400, code: "invalid_copy" });
    expect(await db()`SELECT 1 FROM rate_limits`).toHaveLength(0);
  });

  it("counts against the admin's hourly limit, and a refusal writes nothing", async () => {
    const a = await anAdmin();
    await awayFromWindowEdge(3600);
    await db()`
      INSERT INTO rate_limits (bucket, window_start, count)
      VALUES (${`admin:${a}`}, to_timestamp(floor(extract(epoch FROM now()) / 3600) * 3600), ${LIMITS.adminPerHour.limit})`;
    await expect(save(a, "about.title", "Too many", 0)).rejects.toMatchObject({
      status: 429,
    });
    expect(await db()`SELECT 1 FROM copy_versions`).toHaveLength(0);
    expect(
      await db()`SELECT 1 FROM action_log WHERE action = 'copy.edit'`,
    ).toHaveLength(0);
  });

  it("finds an old version only under its own piece", async () => {
    const a = await anAdmin();
    const v = await save(a, "about.title", "Old words", 0);
    expect(await versionBody(db(), "about.title", v.version)).toBe("Old words");
    await expect(
      versionBody(db(), "home.title", v.version),
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
