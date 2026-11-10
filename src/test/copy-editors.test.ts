import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { savedBy } from "@/app/admin/copy-who";
import { POST as copyMcpRoute } from "@/app/v1/copy/mcp/[token]/route";
import { POST as copyMcpHeaderRoute } from "@/app/v1/copy/mcp/route";
import {
  addAdmin,
  adminFor,
  listAdmins,
  removeAdmin,
  roleFor,
} from "@/lib/admins";
import {
  adminOnlyCopy,
  COPY,
  type CopyEditor,
  type CopyKey,
  checkCopy,
  copyHistory,
  readCopy,
  recentCopyChanges,
  saveCopy,
  undoCopy,
} from "@/lib/copy";
import {
  COPY_KEY_PREFIX,
  copyEditorForKey,
  listCopyKeys,
  makeCopyKey,
  revokeCopyKey,
} from "@/lib/copy-editors";
import { db } from "@/lib/db";
import { redactPath } from "@/lib/http";
import { hashKey } from "@/lib/keys";
import { LIMITS } from "@/lib/limits";
import { freshIp, register, resetDb } from "./helpers";

// Copy editors: people (role 'copy') and apps (copy keys) that change the
// words on people's pages, and nothing else in the admin space.

const session = vi.hoisted(() => ({ user: null as null | { id: string } }));

vi.mock("@/lib/human-auth", () => ({
  humanSignInEnabled: () => true,
  sessionUser: async () =>
    session.user ? { id: session.user.id, email: null } : null,
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-real-ip": "10.9.9.7" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
  notFound: () => {
    throw new Error("not found");
  },
}));
vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  connection: async () => {},
}));

beforeEach(async () => {
  await resetDb();
  session.user = null;
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.UNPROMPTED_READ_ONLY;
});

const asAdmin = (humanId: number): CopyEditor => ({
  humanId,
  role: "admin",
  keyId: null,
});

async function anAdmin(id = "google-admin"): Promise<number> {
  return (await addAdmin(db(), { authUserId: id }, "Admin.", "x")).humanId;
}

async function aCopyEditor(id = "google-editor"): Promise<number> {
  return (await addAdmin(db(), { authUserId: id }, "Words.", "x", "copy"))
    .humanId;
}

async function aKey(humanId: number, label = "assistant") {
  return makeCopyKey(db(), { humanId, label, reason: "For my assistant." });
}

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

describe("the copy editor role", () => {
  it("is a role of its own, and isn't an admin", async () => {
    const editor = await aCopyEditor();
    expect(await adminFor(db(), "google-editor")).toBeUndefined();
    expect(await roleFor(db(), "google-editor")).toEqual({
      humanId: editor,
      role: "copy",
    });
    await anAdmin();
    expect(await roleFor(db(), "google-admin")).toMatchObject({
      role: "admin",
    });
    expect((await listAdmins(db())).map((a) => a.role)).toEqual([
      "copy",
      "admin",
    ]);
    const [log] = await db()<{ detail: { role: string } }[]>`
      SELECT detail FROM action_log WHERE action = 'access.admin.add'
      ORDER BY id LIMIT 1`;
    expect(log?.detail.role).toBe("copy");
  });

  it("is only admin or copy, and isn't changed by adding again", async () => {
    await expect(
      addAdmin(db(), { authUserId: "google-x" }, "Why.", "x", "owner"),
    ).rejects.toThrow(/admin or copy/);
    await aCopyEditor();
    const again = await addAdmin(
      db(),
      { authUserId: "google-editor" },
      "Promote.",
      "x",
    );
    expect(again).toMatchObject({ changed: false, role: "copy" });
    expect(await adminFor(db(), "google-editor")).toBeUndefined();
  });

  // Copy editors live apart from admins, so code that reads admins (code
  // from before roles, a rolled-back deploy) never sees one as an admin.
  it("is kept apart from admins, and no one is both", async () => {
    const editor = await aCopyEditor();
    const [inAdmins] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM admins WHERE human_id = ${editor}`;
    expect(inAdmins?.n).toBe(0);
    await expect(
      db()`INSERT INTO admins (human_id) VALUES (${editor})`,
    ).rejects.toThrow(/not both/);
    const admin = await anAdmin();
    await expect(
      db()`INSERT INTO copy_editors (human_id) VALUES (${admin})`,
    ).rejects.toThrow(/not both/);
    const [cols] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_name = 'admins' AND column_name = 'role'`;
    expect(cols?.n).toBe(0);
  });

  it("saves words and is recorded as who saved them", async () => {
    const editor = await aCopyEditor();
    const r = await saveCopy(db(), {
      key: "home.tagline",
      body: "Words a copy editor wrote.",
      after: 0,
      editor: { humanId: editor, role: "copy", keyId: null },
      ipHash: null,
    });
    expect(r.changed).toBe(true);
    expect((await readCopy())["home.tagline"]).toBe(
      "Words a copy editor wrote.",
    );
    const [v] = await copyHistory(db(), "home.tagline");
    expect(v).toMatchObject({ human_id: editor, copy_key: null });
    const [log] = await db()<{ human_id: string; detail: unknown }[]>`
      SELECT human_id, detail FROM action_log WHERE action = 'copy.edit'`;
    expect(log).toMatchObject({
      human_id: String(editor),
      detail: { version: r.version, role: "copy" },
    });
  });

  it("can't change the privacy page or the line pasted into agents", async () => {
    const editor = await aCopyEditor();
    for (const key of ["home.paste_line", "privacy.lead"] as const)
      await expect(
        saveCopy(db(), {
          key,
          body: COPY[key].text,
          after: 0,
          editor: { humanId: editor, role: "copy", keyId: null },
          ipHash: null,
        }),
      ).rejects.toThrow(/Only an admin/);
    expect(await db()`SELECT 1 FROM copy_versions`).toHaveLength(0);
  });

  // Words a person trusts the site for: what it vouches for, what it says
  // about owners, the page that allows an app, and the badges and name.
  it("can't change what the site vouches for, or the connect page", async () => {
    const trusted: CopyKey[] = [
      "bot.profile.note",
      "bot.key.note",
      "connect.back",
      "connect.app_named",
      "connect.unknown_app",
      "home.paste_label",
      "account.code.note",
      "site.badge.house",
      "site.name",
      "sign_in.privacy",
    ];
    for (const key of trusted) expect(adminOnlyCopy(key), key).toBe(true);
    for (const key of ["home.tagline", "forum.title"] as const)
      expect(adminOnlyCopy(key), key).toBe(false);
    const editor = await aCopyEditor();
    const admin = await anAdmin();
    const k = await aKey(admin);
    const key = await copyEditorForKey(db(), k.secret);
    for (const who of [
      { humanId: editor, role: "copy" as const, keyId: null },
      key,
    ])
      await expect(
        saveCopy(db(), {
          key: "bot.profile.note",
          body: "Checked by the site: what {handle} says about itself is true.",
          after: 0,
          editor: who,
          ipHash: null,
        }),
      ).rejects.toMatchObject({ code: "admin_only" });
    // An admin, signed in, still can.
    const r = await saveCopy(db(), {
      key: "connect.back",
      body: "You'll go back to {host} once you allow it.",
      after: 0,
      editor: asAdmin(admin),
      ipHash: null,
    });
    expect(r.changed).toBe(true);
  });

  it("holds every piece, not only the privacy page, to no promise about owners", () => {
    for (const key of [
      "sign_in.privacy",
      "home.tagline",
      "forum.title",
    ] as const)
      expect(() =>
        checkCopy(key, "Nobody sees which bots belong to you."),
      ).toThrow(/which bots belong to whom/);
  });
});

describe("a copy editor on the admin pages", () => {
  const actions = () => import("@/app/admin/actions");

  it("may save, restore and undo copy", async () => {
    await aCopyEditor();
    session.user = { id: "google-editor" };
    const a = await actions();
    expect(
      await a.saveCopyAction(
        {},
        form({ key: "home.tagline", body: "New words.", after: "0" }),
      ),
    ).toEqual({ message: "Saved." });
    const [v] = await copyHistory(db(), "home.tagline");
    expect(
      await a.undoCopyAction({}, form({ version: String(v?.id) })),
    ).toEqual({ message: "Undone." });
    expect((await readCopy())["home.tagline"]).toBe(COPY["home.tagline"].text);
    const latest = (await copyHistory(db(), "home.tagline"))[0]?.id ?? 0;
    expect(
      await a.restoreCopyAction(
        {},
        form({
          key: "home.tagline",
          version: String(v?.id),
          after: String(latest),
        }),
      ),
    ).toEqual({ message: "Restored." });
    expect((await readCopy())["home.tagline"]).toBe("New words.");
  });

  it("is refused everything else an admin does, and the admin-only words", async () => {
    await aCopyEditor();
    const maker = await anAdmin();
    const key = await aKey(maker);
    session.user = { id: "google-editor" };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = await actions();
    const refused = [
      a.saveBotTextAction({}, form({ key: "welcome", body: "x", after: "0" })),
      a.saveDescriptionAction(
        {},
        form({ slug: "prompted", body: "x", after: "0" }),
      ),
      a.moderateAction({}, form({ op: "pause", reason: "Flood." })),
      a.makeModKeyAction(
        {},
        form({ role: "moderator", label: "mine", reason: "x" }),
      ),
      a.makeCopyKeyAction({}, form({ label: "mine", reason: "x" })),
      a.revokeCopyKeyAction({}, form({ id: String(key.id), reason: "x" })),
    ];
    for (const r of await Promise.all(refused))
      expect(r).toEqual({ error: "Only admins can do that." });
    expect(
      await a.saveCopyAction(
        {},
        form({ key: "privacy.lead", body: "x", after: "0" }),
      ),
    ).toEqual({ error: "Only an admin, signed in, can change these words." });
    expect(
      await db()`SELECT 1 FROM copy_keys WHERE revoked_at IS NOT NULL`,
    ).toHaveLength(0);
    expect(await db()`SELECT 1 FROM copy_versions`).toHaveLength(0);
    warn.mockRestore();
  });

  it("sees only the words, with no keys, and the rest says not an admin", async () => {
    const maker = await anAdmin();
    await aKey(maker, "secret-label");
    await aCopyEditor();
    session.user = { id: "google-editor" };
    const copy = (await import("@/app/admin/copy/page")).default;
    const moderation = (await import("@/app/admin/page")).default;
    const modKeys = (await import("@/app/admin/mod-keys/page")).default;
    const html = renderToStaticMarkup(await copy());
    expect(html).toContain("Words on the site");
    expect(html).toContain("Recent changes");
    expect(html).not.toContain("Keys for apps");
    expect(html).not.toContain("secret-label");
    expect(html).not.toContain('href="/admin/mod-keys"');
    expect(html).not.toContain('href="/admin/lookup"');
    // A box for the tagline, none for the privacy page.
    expect(html).toContain('value="home.tagline"');
    expect(html).not.toContain('value="privacy.lead"');
    for (const page of [moderation, modKeys])
      expect(renderToStaticMarkup(await page())).toContain("Not an admin");
  });

  it("is sent to the words from the account page", async () => {
    await aCopyEditor();
    session.user = { id: "google-editor" };
    const account = (await import("@/app/account/page")).default;
    const html = renderToStaticMarkup(await account());
    expect(html).toContain('href="/admin/copy"');
    expect(html).not.toContain('href="/admin"');
  });

  it("an admin sees the keys and every box", async () => {
    const maker = await anAdmin();
    await aKey(maker, "my-assistant");
    session.user = { id: "google-admin" };
    const copy = (await import("@/app/admin/copy/page")).default;
    const html = renderToStaticMarkup(await copy());
    expect(html).toContain("Keys for apps");
    expect(html).toContain("my-assistant");
    expect(html).toContain('value="privacy.lead"');
    expect(html).toContain('href="/admin/mod-keys"');
  });
});

describe("undo", () => {
  it("puts back the words a change replaced, the original for a first change", async () => {
    const admin = await anAdmin();
    const v1 = await saveCopy(db(), {
      key: "forum.title",
      body: "One",
      after: 0,
      editor: asAdmin(admin),
      ipHash: null,
    });
    const v2 = await saveCopy(db(), {
      key: "forum.title",
      body: "Two",
      after: v1.version,
      editor: asAdmin(admin),
      ipHash: null,
    });
    const u = await undoCopy(db(), {
      version: v2.version,
      editor: asAdmin(admin),
      ipHash: null,
    });
    expect(u).toMatchObject({ changed: true, key: "forum.title" });
    expect((await readCopy())["forum.title"]).toBe("One");
    await undoCopy(db(), {
      version: u.version,
      editor: asAdmin(admin),
      ipHash: null,
    });
    expect((await readCopy())["forum.title"]).toBe("Two");
    // History only grows.
    expect(await copyHistory(db(), "forum.title")).toHaveLength(4);
  });

  it("goes back to the original from a first change", async () => {
    const admin = await anAdmin();
    const v1 = await saveCopy(db(), {
      key: "forum.title",
      body: "One",
      after: 0,
      editor: asAdmin(admin),
      ipHash: null,
    });
    await undoCopy(db(), {
      version: v1.version,
      editor: asAdmin(admin),
      ipHash: null,
    });
    expect((await readCopy())["forum.title"]).toBe(COPY["forum.title"].text);
  });

  it("refuses a change someone has changed since, so it never undoes theirs", async () => {
    const admin = await anAdmin();
    const v1 = await saveCopy(db(), {
      key: "forum.title",
      body: "One",
      after: 0,
      editor: asAdmin(admin),
      ipHash: null,
    });
    await saveCopy(db(), {
      key: "forum.title",
      body: "Two",
      after: v1.version,
      editor: asAdmin(admin),
      ipHash: null,
    });
    await expect(
      undoCopy(db(), {
        version: v1.version,
        editor: asAdmin(admin),
        ipHash: null,
      }),
    ).rejects.toThrow(/newer version/);
    await expect(
      undoCopy(db(), { version: 999, editor: asAdmin(admin), ipHash: null }),
    ).rejects.toThrow(/isn't there/);
    expect((await readCopy())["forum.title"]).toBe("Two");
  });

  it("lists recent changes with what they replaced and which can be undone", async () => {
    const admin = await anAdmin();
    const key = await aKey(admin, "assistant");
    const editor = await copyEditorForKey(db(), key.secret);
    const v1 = await saveCopy(db(), {
      key: "forum.title",
      body: "One",
      after: 0,
      editor: asAdmin(admin),
      ipHash: null,
    });
    await saveCopy(db(), {
      key: "forum.title",
      body: "Two",
      after: v1.version,
      editor,
      ipHash: null,
    });
    const changes = await recentCopyChanges(db());
    expect(
      changes.map((c) => [c.body, c.before, c.latest, c.copy_key]),
    ).toEqual([
      ["Two", "One", true, "assistant"],
      ["One", null, false, null],
    ]);
  });
});

describe("copy keys", () => {
  it("are shown once, kept only as a hash, and act as a copy editor under their maker", async () => {
    const admin = await anAdmin();
    const k = await aKey(admin);
    expect(k.secret).toMatch(/^unpcopy_[A-Za-z0-9_-]{43}$/);
    expect(k.secret.startsWith(COPY_KEY_PREFIX)).toBe(true);
    const [row] = await db()<{ key_hash: string }[]>`
      SELECT key_hash FROM copy_keys WHERE id = ${k.id}`;
    expect(row?.key_hash).toBe(hashKey(k.secret));
    const dump = JSON.stringify(await db()`SELECT * FROM copy_keys`);
    expect(dump).not.toContain(k.secret);
    const log = JSON.stringify(await db()`SELECT * FROM action_log`);
    expect(log).not.toContain(k.secret);
    expect(await copyEditorForKey(db(), k.secret)).toEqual({
      humanId: admin,
      role: "copy",
      keyId: k.id,
      label: "assistant",
    });
  });

  it("refuse no key, a malformed key, a bot's key and a made-up one alike", async () => {
    const bot = await register("alice");
    await expect(copyEditorForKey(db(), undefined)).rejects.toMatchObject({
      status: 401,
      code: "missing_key",
    });
    for (const k of [
      "nope",
      bot.key,
      `unpcopy_${"A".repeat(43)}`,
      `unpcopy_${"A".repeat(42)}`,
    ])
      await expect(copyEditorForKey(db(), k)).rejects.toMatchObject({
        status: 401,
        code: "invalid_key",
      });
  });

  it("stop working when revoked, or when their maker stops being a full admin", async () => {
    const admin = await anAdmin();
    const other = await anAdmin("google-other");
    const k = await aKey(admin);
    expect(
      await revokeCopyKey(db(), { id: k.id, humanId: other, reason: "Done." }),
    ).toEqual({ changed: true });
    expect(
      await revokeCopyKey(db(), { id: k.id, humanId: other, reason: "Again." }),
    ).toEqual({ changed: false });
    await expect(copyEditorForKey(db(), k.secret)).rejects.toMatchObject({
      code: "invalid_key",
    });

    const k2 = await aKey(admin, "second");
    await removeAdmin(db(), { authUserId: "google-admin" }, "Left.", "x");
    await expect(copyEditorForKey(db(), k2.secret)).rejects.toMatchObject({
      code: "invalid_key",
    });
    // Back only as a copy editor: still not enough to vouch for a key.
    await aCopyEditor("google-admin");
    await expect(copyEditorForKey(db(), k2.secret)).rejects.toMatchObject({
      code: "invalid_key",
    });
    expect((await listCopyKeys(db())).map((r) => [r.label, r.live])).toEqual([
      ["second", false],
      ["assistant", false],
    ]);
  });

  it("are revoked, and logged, when their maker is removed, so adding them back brings none back", async () => {
    const admin = await anAdmin();
    const k = await aKey(admin);
    const removed = await removeAdmin(
      db(),
      { authUserId: "google-admin" },
      "Left.",
      "x",
    );
    expect(removed).toEqual({ changed: true, role: "admin", revokedKeys: 1 });
    await anAdmin();
    await expect(copyEditorForKey(db(), k.secret)).rejects.toMatchObject({
      code: "invalid_key",
    });
    const [row] = await listCopyKeys(db());
    expect(row?.revoked_at).toBeInstanceOf(Date);
    const logs = await db()<{ action: string; detail: { role?: string } }[]>`
      SELECT action, detail FROM action_log
      WHERE action IN ('access.admin.remove', 'access.copykey.revoke')
      ORDER BY id`;
    expect(logs.map((l) => l.action)).toEqual([
      "access.admin.remove",
      "access.copykey.revoke",
    ]);
    expect(logs[0]?.detail.role).toBe("admin");
  });

  it("show when each last saved words", async () => {
    const admin = await anAdmin();
    const k = await aKey(admin);
    expect((await listCopyKeys(db()))[0]?.last_saved_at).toBeNull();
    await saveCopy(db(), {
      key: "forum.title",
      body: "Saved by the key.",
      after: 0,
      editor: await copyEditorForKey(db(), k.secret),
      ipHash: null,
    });
    expect((await listCopyKeys(db()))[0]?.last_saved_at).toBeInstanceOf(Date);
  });

  it("spend their own budget, and leave their maker's alone when it runs out", async () => {
    const admin = await anAdmin();
    const k = await aKey(admin);
    const editor = await copyEditorForKey(db(), k.secret);
    let after = 0;
    for (let i = 0; i < LIMITS.copyKeyPerHour.limit; i++)
      after = (
        await saveCopy(db(), {
          key: "forum.title",
          body: `Words ${i}.`,
          after,
          editor,
          ipHash: null,
        })
      ).version;
    await expect(
      saveCopy(db(), {
        key: "forum.title",
        body: "One too many.",
        after,
        editor,
        ipHash: null,
      }),
    ).rejects.toMatchObject({ status: 429 });
    const mine = await saveCopy(db(), {
      key: "forum.title",
      body: "The maker's own words.",
      after,
      editor: asAdmin(admin),
      ipHash: null,
    });
    expect(mine.changed).toBe(true);
  });

  it("are refused at the save itself if revoked after the request began", async () => {
    const admin = await anAdmin();
    const k = await aKey(admin);
    const editor = await copyEditorForKey(db(), k.secret);
    await revokeCopyKey(db(), { id: k.id, humanId: admin, reason: "Now." });
    await expect(
      saveCopy(db(), {
        key: "forum.title",
        body: "Too late.",
        after: 0,
        editor,
        ipHash: null,
      }),
    ).rejects.toMatchObject({ code: "invalid_key" });
    expect(await db()`SELECT 1 FROM copy_versions`).toHaveLength(0);
  });

  it("save under their maker's name and their own hourly limit, and never the admin-only words", async () => {
    const admin = await anAdmin();
    const k = await aKey(admin);
    const editor = await copyEditorForKey(db(), k.secret);
    const spent = async (bucket: string) =>
      (
        await db()<{ count: number }[]>`
          SELECT coalesce(sum(count), 0)::int AS count FROM rate_limits
          WHERE bucket = ${bucket}`
      )[0]?.count ?? 0;
    const before = await spent(`admin:${admin}`);
    const r = await saveCopy(db(), {
      key: "forum.title",
      body: "From the key.",
      after: 0,
      editor,
      ipHash: null,
    });
    const [v] = await db()<{ human_id: string; copy_key_id: string }[]>`
      SELECT human_id, copy_key_id FROM copy_versions WHERE id = ${r.version}`;
    expect(v).toEqual({ human_id: String(admin), copy_key_id: String(k.id) });
    // The key's own budget, never its maker's.
    expect(await spent(`admin:${admin}`)).toBe(before);
    expect(await spent(`copykey:${k.id}`)).toBe(1);
    const [log] = await db()<{ detail: unknown }[]>`
      SELECT detail FROM action_log WHERE action = 'copy.edit'`;
    expect(log?.detail).toEqual({ version: r.version, copy_key: k.id });
    await expect(
      saveCopy(db(), {
        key: "privacy.lead",
        body: COPY["privacy.lead"].text,
        after: 0,
        editor,
        ipHash: null,
      }),
    ).rejects.toMatchObject({ code: "admin_only" });
  });

  it("need a fresh label each, a valid one, and a reason", async () => {
    const admin = await anAdmin();
    await aKey(admin, "assistant");
    const k2 = await aKey(admin, "spare");
    await revokeCopyKey(db(), { id: k2.id, humanId: admin, reason: "x" });
    for (const label of ["assistant", "spare"])
      await expect(aKey(admin, label)).rejects.toMatchObject({
        code: "label_taken",
      });
    for (const label of ["A", "1abc", "has space", "x".repeat(31)])
      await expect(aKey(admin, label)).rejects.toMatchObject({
        code: "invalid",
      });
    await expect(
      makeCopyKey(db(), { humanId: admin, label: "ok-one", reason: "" }),
    ).rejects.toMatchObject({ code: "invalid_reason" });
  });

  it("are never deleted, and only revoked_at changes, once", async () => {
    const admin = await anAdmin();
    const k = await aKey(admin);
    await expect(
      db()`DELETE FROM copy_keys WHERE id = ${k.id}`,
    ).rejects.toThrow(/never deleted/);
    await expect(
      db()`UPDATE copy_keys SET label = 'other' WHERE id = ${k.id}`,
    ).rejects.toThrow(/only revoked_at/);
    await expect(
      db()`UPDATE copy_keys SET human_id = ${admin} + 1 WHERE id = ${k.id}`,
    ).rejects.toThrow(/only revoked_at/);
    await db()`UPDATE copy_keys SET revoked_at = now() WHERE id = ${k.id}`;
    await expect(
      db()`UPDATE copy_keys SET revoked_at = NULL WHERE id = ${k.id}`,
    ).rejects.toThrow(/only revoked_at/);
  });

  it("are made and revoked by an admin on the page, and revoking works when read-only", async () => {
    await anAdmin();
    session.user = { id: "google-admin" };
    const a = await import("@/app/admin/actions");
    const made = await a.makeCopyKeyAction(
      {},
      form({ label: "assistant", reason: "For my assistant." }),
    );
    expect(made.secret).toMatch(/^unpcopy_/);
    const [row] = await listCopyKeys(db());
    process.env.UNPROMPTED_READ_ONLY = "1";
    expect(
      await a.makeCopyKeyAction({}, form({ label: "another", reason: "x" })),
    ).toMatchObject({ error: expect.any(String) });
    expect(
      await a.revokeCopyKeyAction(
        {},
        form({ id: String(row?.id), reason: "Leaked." }),
      ),
    ).toEqual({ message: `Revoked key ${row?.id}.` });
    const log = await db()<{ action: string }[]>`
      SELECT action FROM action_log WHERE action LIKE 'access.copykey.%'
      ORDER BY id`;
    expect(log.map((l) => l.action)).toEqual([
      "access.copykey.add",
      "access.copykey.revoke",
    ]);
  });
});

describe("the copy connector", () => {
  let rpcId = 0;
  async function mcp(
    token: string | undefined,
    method: string,
    params: Record<string, unknown> = {},
  ) {
    rpcId += 1;
    const req = new Request(
      `http://unprompted.test/v1/copy/mcp/${token ?? ""}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "x-real-ip": freshIp(),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params }),
      },
    );
    const res = await copyMcpRoute(req, {
      params: Promise.resolve(token === undefined ? {} : { token }),
    });
    const text = await res.text();
    // biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary JSON
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {}
    return { status: res.status, body };
  }
  async function tool(
    token: string,
    name: string,
    args: Record<string, unknown> = {},
  ) {
    const res = await mcp(token, "tools/call", { name, arguments: args });
    expect(res.status).toBe(200);
    const result = res.body.result;
    const text = result?.content?.[0]?.text ?? "";
    // biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary JSON
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {}
    return { isError: result?.isError === true, data };
  }

  async function aConnectorKey(): Promise<string> {
    return (await aKey(await anAdmin())).secret;
  }

  it("refuses no key, a dead key and a bot's key, and never logs the key", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const bot = await register("alice");
    const none = await mcp(undefined, "tools/list");
    expect(none.status).toBe(401);
    expect(none.body.error.code).toBe("missing_key");
    const fake = `unpcopy_${"B".repeat(43)}`;
    for (const k of [fake, bot.key]) {
      const r = await mcp(k, "tools/list");
      expect(r.status).toBe(401);
      expect(r.body.error.code).toBe("invalid_key");
    }
    const logged = [warn, error, log]
      .flatMap((s) => s.mock.calls.map((c) => c.map(String).join(" ")))
      .join("\n");
    expect(logged).toContain("/v1/copy/mcp/[key]");
    expect(logged).not.toContain(fake);
    expect(logged).not.toContain(bot.key);
  });

  it("takes the key in a header at /copy/mcp, for an app that can send one", async () => {
    const key = await aConnectorKey();
    const call = (auth?: string) =>
      copyMcpHeaderRoute(
        new Request("http://unprompted.test/v1/copy/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "x-real-ip": freshIp(),
            ...(auth ? { authorization: auth } : {}),
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        }),
        { params: Promise.resolve({}) },
      );
    expect((await call(`Bearer ${key}`)).status).toBe(200);
    expect((await call()).status).toBe(401);
    expect((await call(`Bearer unpcopy_${"C".repeat(43)}`)).status).toBe(401);
  });

  it("has four tools: list, history, edit and restore", async () => {
    const key = await aConnectorKey();
    const r = await mcp(key, "tools/list");
    expect(r.status).toBe(200);
    expect(
      r.body.result.tools.map((t: { name: string }) => t.name).sort(),
    ).toEqual(["copy_history", "edit_copy", "list_copy", "restore_copy"]);
  });

  it("lists every piece with the words showing and whether it may change them", async () => {
    const key = await aConnectorKey();
    const { data } = await tool(key, "list_copy");
    const pieces = data.pages.flatMap(
      (p: { pieces: { key: string }[] }) => p.pieces,
    );
    expect(pieces).toHaveLength(Object.keys(COPY).length);
    const tagline = pieces.find(
      (p: { key: string }) => p.key === "home.tagline",
    );
    expect(tagline).toMatchObject({
      words: COPY["home.tagline"].text,
      version: 0,
      editable: true,
    });
    const privacy = pieces.find(
      (p: { key: string }) => p.key === "privacy.lead",
    );
    expect(privacy.editable).toBe(false);
    const only = await tool(key, "list_copy", { page: "forum" });
    expect(only.data.pages).toHaveLength(1);
  });

  it("edits, shows history, and goes back, all under the key's name", async () => {
    const key = await aConnectorKey();
    const e = await tool(key, "edit_copy", {
      key: "home.tagline",
      words: "Words from the assistant.",
      after: 0,
    });
    expect(e).toEqual({
      isError: false,
      data: { saved: true, version: expect.any(Number) },
    });
    expect((await readCopy())["home.tagline"]).toBe(
      "Words from the assistant.",
    );
    const h = await tool(key, "copy_history", { key: "home.tagline" });
    expect(h.data.versions[0]).toMatchObject({
      version: e.data.version,
      words: "Words from the assistant.",
      by: "this key",
    });
    const back = await tool(key, "restore_copy", {
      key: "home.tagline",
      version: "original",
      after: e.data.version,
    });
    expect(back.data.saved).toBe(true);
    expect((await readCopy())["home.tagline"]).toBe(COPY["home.tagline"].text);
    const again = await tool(key, "restore_copy", {
      key: "home.tagline",
      version: e.data.version,
      after: back.data.version,
    });
    expect(again.data.saved).toBe(true);
    expect((await readCopy())["home.tagline"]).toBe(
      "Words from the assistant.",
    );
  });

  it("is refused what a copy editor is refused, with the same checks as the page", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const key = await aConnectorKey();
    const cases: [Record<string, unknown>, string][] = [
      [
        { key: "privacy.lead", words: COPY["privacy.lead"].text, after: 0 },
        "admin_only",
      ],
      [
        {
          key: "home.paste_line",
          words: COPY["home.paste_line"].text,
          after: 0,
        },
        "admin_only",
      ],
      [{ key: "home.tagline", words: "Hidden​word.", after: 0 }, "invalid_copy"],
      [{ key: "home.tagline", words: "Stale.", after: 7 }, "copy_changed"],
    ];
    for (const [args, code] of cases) {
      const r = await tool(key, "edit_copy", args);
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(r.data.error.code, JSON.stringify(args)).toBe(code);
    }
    const unknown = await tool(key, "edit_copy", {
      key: "no.such",
      words: "x",
      after: 0,
    });
    expect(unknown.isError).toBe(true);
    expect(await db()`SELECT 1 FROM copy_versions`).toHaveLength(0);
    warn.mockRestore();
  });

  it("drops a spot only where the page has none", async () => {
    const key = await aConnectorKey();
    const piece = Object.entries(COPY).find(
      ([k, e]) => /\{[a-z_]+\}/.test(e.text) && !adminOnlyCopy(k as CopyKey),
    );
    expect(piece).toBeDefined();
    const [k] = piece ?? [""];
    const r = await tool(key, "edit_copy", {
      key: k,
      words: "No spots at all.",
      after: 0,
    });
    expect(r.isError).toBe(true);
    expect(r.data.error.code).toBe("invalid_copy");
  });

  it("writes nothing under the kill switch, and stops when the key is revoked", async () => {
    const admin = await anAdmin();
    const k = await aKey(admin);
    process.env.UNPROMPTED_READ_ONLY = "1";
    const ro = await tool(k.secret, "edit_copy", {
      key: "home.tagline",
      words: "No.",
      after: 0,
    });
    expect(ro.data.error.code).toBe("read_only");
    // Reading still works.
    expect((await tool(k.secret, "list_copy")).isError).toBe(false);
    delete process.env.UNPROMPTED_READ_ONLY;
    await revokeCopyKey(db(), { id: k.id, humanId: admin, reason: "Done." });
    const dead = await mcp(k.secret, "tools/list");
    expect(dead.status).toBe(401);
    expect(await db()`SELECT 1 FROM copy_versions`).toHaveLength(0);
  });
});

describe("redactPath", () => {
  it("hides a copy connector's key, and nothing else", () => {
    expect(redactPath("/v1/copy/mcp/unpcopy_abc")).toBe("/v1/copy/mcp/[key]");
    expect(redactPath("/copy/mcp/unpcopy_abc")).toBe("/copy/mcp/[key]");
    expect(redactPath("/v1/posts/1/vote")).toBe("/v1/posts/1/vote");
    expect(redactPath("/v1/mcp")).toBe("/v1/mcp");
    // Odd spellings of the address, and a key anywhere else in a path.
    expect(redactPath("//copy/mcp/unpcopy_abc")).toBe("//copy/mcp/[key]");
    expect(redactPath("/Copy/MCP/unpcopy_abc")).toBe("/Copy/MCP/[key]");
    expect(redactPath(`/x/unpcopy_${"A".repeat(43)}/y`)).toBe(
      "/x/unpcopy_[key]/y",
    );
  });
});

describe("who saved a version, on the copy pages", () => {
  it("names people and keys to admins, and only a person or an app to copy editors", () => {
    const person = { human_id: 3, copy_key: null };
    const app = { human_id: 3, copy_key: "assistant" };
    expect(savedBy(person, true)).toBe("human 3");
    expect(savedBy(app, true)).toBe("key assistant, made by human 3");
    expect(savedBy(person, false)).toBe("a person");
    expect(savedBy(app, false)).toBe("an app");
  });
});
