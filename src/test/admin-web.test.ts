import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as report } from "@/app/v1/posts/[id]/report/route";
import { POST as post } from "@/app/v1/posts/route";
import { banBot, hidePost, moderatorLog, setSilenced } from "@/lib/admin";
import { addAdmin, adminFor, listAdmins, removeAdmin } from "@/lib/admins";
import { BOT_TEXTS, builtInText, saveBotText } from "@/lib/bot-texts";
import { saveDescription } from "@/lib/channel-descriptions";
import { COPY, readCopy, saveCopy } from "@/lib/copy";
import { db } from "@/lib/db";
import { HOUSE_HANDLE, syncWelcome } from "@/lib/house";
import { issueOwnerCode } from "@/lib/humans";
import { LIMITS } from "@/lib/limits";
import { awayFromWindowEdge, call, register, resetDb } from "./helpers";

// Who is an admin, and the admin pages' actions. The actions are POST
// endpoints like any other, so these call each one with no session and with
// a signed-in human who isn't an admin, and check that neither writes.

const session = vi.hoisted(() => ({ user: null as null | { id: string } }));
const nav = vi.hoisted(() => ({ redirects: [] as string[] }));

vi.mock("@/lib/human-auth", () => ({
  humanSignInEnabled: () => true,
  sessionUser: async () =>
    session.user ? { id: session.user.id, email: null } : null,
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-real-ip": "10.9.9.8" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    nav.redirects.push(to);
    throw new Error(`redirect ${to}`);
  },
  notFound: () => {
    throw new Error("not found");
  },
}));
// Pages wait for a request before reading the database; here there is none.
vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  connection: async () => {},
}));

beforeEach(async () => {
  await resetDb();
  session.user = null;
  nav.redirects = [];
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.UNPROMPTED_READ_ONLY;
});

// A stand-in for the table Neon Auth keeps in its own schema.
async function fakeNeonAuth() {
  await db()`CREATE SCHEMA IF NOT EXISTS neon_auth`;
  await db()`
    CREATE TABLE IF NOT EXISTS neon_auth."user" (
      id uuid PRIMARY KEY, email text UNIQUE, "emailVerified" boolean NOT NULL)`;
  await db()`TRUNCATE neon_auth."user"`;
  await db()`
    INSERT INTO neon_auth."user" (id, email, "emailVerified") VALUES
      ('00000000-0000-4000-8000-000000000001', 'Ada@Example.com', true),
      ('00000000-0000-4000-8000-000000000002', 'eve@example.com', false)`;
}
const ADA = "00000000-0000-4000-8000-000000000001";

async function writes() {
  const [r] = await db()<
    {
      log: number;
      copy: number;
      bot_texts: number;
      descriptions: number;
      posts: number;
      hidden: number;
      admins: number;
    }[]
  >`
    SELECT (SELECT count(*) FROM action_log)::int AS log,
           (SELECT count(*) FROM copy_versions)::int AS copy,
           (SELECT count(*) FROM bot_text_versions)::int AS bot_texts,
           (SELECT count(*) FROM channel_description_versions)::int AS descriptions,
           (SELECT count(*) FROM posts)::int AS posts,
           (SELECT count(*) FROM hidden_posts)::int AS hidden,
           (SELECT count(*) FROM admins)::int AS admins`;
  return r;
}

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

async function aPost(): Promise<number> {
  const a = await register("alice");
  const res = await call(post, {
    key: a.key,
    body: { channel: "meta", body: "hello" },
  });
  return res.body.post.id as number;
}

describe("adding an admin", () => {
  it("says what to do where Neon Auth isn't in the database", async () => {
    await db()`DROP SCHEMA IF EXISTS neon_auth CASCADE`;
    await expect(
      addAdmin(db(), { email: "ada@example.com" }, "Runs the site.", "x"),
    ).rejects.toMatchObject({ code: "no_sign_ins" });
    expect(await listAdmins(db())).toEqual([]);
  });

  it("finds them by the address Google verified, in any case", async () => {
    await fakeNeonAuth();
    const r = await addAdmin(
      db(),
      { email: "ada@example.COM" },
      "Runs the site.",
      "district",
    );
    expect(r.changed).toBe(true);
    expect(await adminFor(db(), ADA)).toBe(r.humanId);
    // The site's own tables still keep only the sign-in id.
    const [h] = await db()`SELECT auth_user_id FROM humans`;
    expect(h?.auth_user_id).toBe(ADA);
    expect(JSON.stringify(await db()`SELECT * FROM action_log`)).not.toMatch(
      /ada@/i,
    );
  });

  it("refuses an address that isn't verified or never signed in", async () => {
    await fakeNeonAuth();
    await expect(
      addAdmin(db(), { email: "eve@example.com" }, "No.", "x"),
    ).rejects.toMatchObject({ code: "not_signed_in" });
    await expect(
      addAdmin(db(), { email: "nobody@example.com" }, "No.", "x"),
    ).rejects.toMatchObject({ code: "not_signed_in" });
    expect((await writes())?.admins).toBe(0);
  });

  it("needs a reason, and logs it, but not among the moderation actions", async () => {
    await expect(
      addAdmin(db(), { authUserId: "google-1" }, "", "x"),
    ).rejects.toMatchObject({ code: "invalid_reason" });
    await addAdmin(
      db(),
      { authUserId: "google-1" },
      "Helps moderate.",
      "district",
    );
    expect(
      (await addAdmin(db(), { authUserId: "google-1" }, "Again.", "district"))
        .changed,
    ).toBe(false);
    const log = await db()`SELECT action, detail FROM action_log`;
    expect(log).toEqual([
      {
        action: "access.admin.add",
        detail: { reason: "Helps moderate.", by: "district" },
      },
    ]);
    expect(await moderatorLog(db(), { limit: 10 })).toEqual([]);
  });

  it("can be undone, and lists who's an admin for the command line", async () => {
    await fakeNeonAuth();
    await addAdmin(db(), { email: "ada@example.com" }, "Runs the site.", "x");
    expect((await listAdmins(db())).map((a) => a.email)).toEqual([
      "Ada@Example.com",
    ]);
    expect(
      (
        await removeAdmin(
          db(),
          { email: "ada@example.com" },
          "Stepped back.",
          "x",
        )
      ).changed,
    ).toBe(true);
    expect(await adminFor(db(), ADA)).toBeUndefined();
    expect(
      (await removeAdmin(db(), { authUserId: ADA }, "Again.", "x")).changed,
    ).toBe(false);
    expect(await listAdmins(db())).toEqual([]);
  });
});

describe("admin actions", () => {
  const calls = async () => {
    const a = await import("@/app/admin/actions");
    return {
      saveCopy: () =>
        a.saveCopyAction(
          {},
          form({ key: "home.tagline", body: "Taken over.", after: "0" }),
        ),
      restoreCopy: () =>
        a.restoreCopyAction(
          {},
          form({ key: "home.tagline", version: "original", after: "0" }),
        ),
      saveBotText: () =>
        a.saveBotTextAction(
          {},
          form({ key: "welcome", body: "Taken over.", after: "0" }),
        ),
      restoreBotText: () =>
        a.restoreBotTextAction(
          {},
          form({ key: "questions", version: "original", after: "0" }),
        ),
      saveDescription: () =>
        a.saveDescriptionAction(
          {},
          form({ slug: "prompted", body: "Taken over.", after: "0" }),
        ),
      restoreDescription: () =>
        a.restoreDescriptionAction(
          {},
          form({ slug: "prompted", version: "original", after: "0" }),
        ),
      hide: (id: number) =>
        a.moderateAction(
          {},
          form({ op: "hide", target: String(id), reason: "Spam." }),
        ),
      pause: () =>
        a.moderateAction({}, form({ op: "pause", reason: "Flood." })),
    };
  };

  it("send anyone with no session to sign in, and write nothing", async () => {
    const id = await aPost();
    const before = await writes();
    const c = await calls();
    const runs = [
      c.saveCopy,
      c.restoreCopy,
      c.saveBotText,
      c.restoreBotText,
      c.saveDescription,
      c.restoreDescription,
      () => c.hide(id),
      c.pause,
    ];
    for (const run of runs)
      await expect(run()).rejects.toThrow("redirect /sign-in");
    expect(nav.redirects).toHaveLength(runs.length);
    expect(await writes()).toEqual(before);
  });

  it("refuse a signed-in human who isn't an admin, and log the refusal", async () => {
    const id = await aPost();
    await addAdmin(db(), { authUserId: "google-admin" }, "Admin.", "x");
    // A human the site knows, as a real non-admin is once they've asked for
    // an owner code.
    await issueOwnerCode(db(), "google-someone", null);
    session.user = { id: "google-someone" };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const before = await writes();
    const c = await calls();
    const runs = [
      c.saveCopy,
      c.restoreCopy,
      c.saveBotText,
      c.restoreBotText,
      c.saveDescription,
      c.restoreDescription,
      () => c.hide(id),
      c.pause,
    ];
    for (const run of runs)
      expect(await run()).toEqual({ error: "Only admins can do that." });
    expect(await writes()).toEqual(before);
    expect(warn).toHaveBeenCalledTimes(runs.length);
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
      method: "ACTION",
      path: "saveCopy",
      status: 403,
      code: "not_admin",
    });
  });

  it("count an admin's moderation against their hourly limit, and a refusal writes nothing", async () => {
    const id = await aPost();
    const { humanId } = await addAdmin(
      db(),
      { authUserId: "google-admin" },
      "Admin.",
      "x",
    );
    session.user = { id: "google-admin" };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await awayFromWindowEdge(3600);
    await db()`
      INSERT INTO rate_limits (bucket, window_start, count)
      VALUES (${`admin:${humanId}`}, to_timestamp(floor(extract(epoch FROM now()) / 3600) * 3600), ${LIMITS.adminPerHour.limit})`;
    const before = await writes();
    const c = await calls();
    for (const run of [() => c.hide(id), c.pause])
      expect((await run()).error).toMatch(/Rate limit/);
    expect(await writes()).toEqual(before);
  });

  it("stop working the moment an admin is removed", async () => {
    await addAdmin(db(), { authUserId: "google-admin" }, "Admin.", "x");
    session.user = { id: "google-admin" };
    const c = await calls();
    expect(await c.saveCopy()).toEqual({ message: "Saved." });
    await removeAdmin(db(), { authUserId: "google-admin" }, "Done.", "x");
    expect(await c.restoreCopy()).toEqual({
      error: "Only admins can do that.",
    });
  });

  it("save copy for an admin, and go back to the original", async () => {
    const { humanId } = await addAdmin(
      db(),
      { authUserId: "google-admin" },
      "Admin.",
      "x",
    );
    session.user = { id: "google-admin" };
    const a = await import("@/app/admin/actions");
    expect(
      await a.saveCopyAction(
        {},
        form({ key: "home.tagline", body: "Bots at play.", after: "0" }),
      ),
    ).toEqual({ message: "Saved." });
    expect((await readCopy())["home.tagline"]).toBe("Bots at play.");
    const [v] = await db()<{ id: string; human_id: string }[]>`
      SELECT id, human_id FROM copy_versions`;
    expect(Number(v?.human_id)).toBe(humanId);
    // Two admins on an old page: the second is told to reload.
    expect(
      await a.saveCopyAction(
        {},
        form({ key: "home.tagline", body: "Mine instead.", after: "0" }),
      ),
    ).toEqual({
      error:
        "Someone saved a newer version while you were editing. Reload to see it.",
    });
    expect(
      await a.restoreCopyAction(
        {},
        form({
          key: "home.tagline",
          version: "original",
          after: String(v?.id),
        }),
      ),
    ).toEqual({ message: "Restored." });
    expect((await readCopy())["home.tagline"]).toBe(COPY["home.tagline"].text);
  });

  it("restore an older version as the newest", async () => {
    const { humanId } = await addAdmin(
      db(),
      { authUserId: "google-admin" },
      "Admin.",
      "x",
    );
    session.user = { id: "google-admin" };
    const v1 = await saveCopy(db(), {
      key: "forum.title",
      body: "First words",
      after: 0,
      humanId,
      ipHash: null,
    });
    const v2 = await saveCopy(db(), {
      key: "forum.title",
      body: "Second words",
      after: v1.version,
      humanId,
      ipHash: null,
    });
    const a = await import("@/app/admin/actions");
    expect(
      await a.restoreCopyAction(
        {},
        form({
          key: "forum.title",
          version: String(v1.version),
          after: String(v2.version),
        }),
      ),
    ).toEqual({ message: "Restored." });
    expect((await readCopy())["forum.title"]).toBe("First words");
    expect(await db()`SELECT 1 FROM copy_versions`).toHaveLength(3);
    // A version of another piece can't be restored here.
    expect(
      await a.restoreCopyAction(
        {},
        form({
          key: "home.tagline",
          version: String(v1.version),
          after: "0",
        }),
      ),
    ).toEqual({ error: "That version isn't there." });
  });

  it("restore an older text bots read, or the original, as the newest version", async () => {
    const { humanId } = await addAdmin(
      db(),
      { authUserId: "google-admin" },
      "Admin.",
      "x",
    );
    session.user = { id: "google-admin" };
    const start = await builtInText("start");
    const first = start.replace(
      "# Getting started on Unprompted",
      "# First words",
    );
    const v1 = await saveBotText(db(), {
      key: "start",
      body: first,
      after: 0,
      humanId,
      ipHash: null,
    });
    const v2 = await saveBotText(db(), {
      key: "start",
      body: start.replace("# Getting started on Unprompted", "# Second words"),
      after: v1.version,
      humanId,
      ipHash: null,
    });
    const a = await import("@/app/admin/actions");
    const { botTextState } = await import("@/lib/bot-texts");
    expect(
      await a.restoreBotTextAction(
        {},
        form({
          key: "start",
          version: String(v1.version),
          after: String(v2.version),
        }),
      ),
    ).toEqual({ message: "Restored." });
    expect((await botTextState(db(), "start")).text).toBe(first.trim());
    const v3 = (await botTextState(db(), "start")).latest?.id;
    expect(
      await a.restoreBotTextAction(
        {},
        form({ key: "start", version: "original", after: String(v3) }),
      ),
    ).toEqual({ message: "Restored." });
    expect((await botTextState(db(), "start")).text).toBe(start);
    expect(await db()`SELECT 1 FROM bot_text_versions`).toHaveLength(4);
    // A version of another text can't be restored here.
    expect(
      await a.restoreBotTextAction(
        {},
        form({ key: "skill", version: String(v1.version), after: "0" }),
      ),
    ).toEqual({ error: "That version isn't there." });
  });

  it("restore an older channel description, or the original", async () => {
    const { humanId } = await addAdmin(
      db(),
      { authUserId: "google-admin" },
      "Admin.",
      "x",
    );
    session.user = { id: "google-admin" };
    const { siteChannels } = await import("@/lib/channel-descriptions");
    const shown = async () =>
      (await siteChannels(db())).find((c) => c.slug === "small-talk");
    const builtIn = (await shown())?.builtIn;
    const d1 = await saveDescription(db(), {
      slug: "small-talk",
      body: "First words.",
      after: 0,
      humanId,
      ipHash: null,
    });
    const d2 = await saveDescription(db(), {
      slug: "small-talk",
      body: "Second words.",
      after: d1.version,
      humanId,
      ipHash: null,
    });
    const a = await import("@/app/admin/actions");
    expect(
      await a.restoreDescriptionAction(
        {},
        form({
          slug: "small-talk",
          version: String(d1.version),
          after: String(d2.version),
        }),
      ),
    ).toEqual({ message: "Restored." });
    expect((await shown())?.shown).toBe("First words.");
    expect(
      await a.restoreDescriptionAction(
        {},
        form({
          slug: "small-talk",
          version: "original",
          after: String((await shown())?.latest?.id),
        }),
      ),
    ).toEqual({ message: "Restored." });
    expect((await shown())?.shown).toBe(builtIn);
    expect(
      await a.restoreDescriptionAction(
        {},
        form({ slug: "meta", version: String(d1.version), after: "0" }),
      ),
    ).toEqual({ error: "That version isn't there." });
  });

  it("refuse what isn't a piece of copy, a version or a lever", async () => {
    await addAdmin(db(), { authUserId: "google-admin" }, "Admin.", "x");
    session.user = { id: "google-admin" };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = await import("@/app/admin/actions");
    const before = await writes();
    for (const f of [
      { key: "nope", body: "x", after: "0" },
      { key: "__proto__", body: "x", after: "0" },
      { key: "home.tagline", body: "x", after: "-1" },
      { key: "home.tagline", body: "x", after: "" },
      { key: "forum.welcome", body: "No link here", after: "0" },
      { key: "home.tagline", body: "Hi\u200B there", after: "0" },
    ])
      expect((await a.saveCopyAction({}, form(f))).error).toBeTruthy();
    for (const f of <Record<string, string>[]>[
      { op: "delete", target: "1", reason: "x" },
      { op: "hide", target: "abc", reason: "x" },
      { op: "freeze", target: "Not A Handle!", reason: "x" },
      { op: "hide", target: "999", reason: "x" },
      { op: "pause", reason: "" },
    ])
      expect((await a.moderateAction({}, form(f))).error).toBeTruthy();
    expect(await writes()).toEqual(before);
  });

  it("moderate as the admin, in the moderators' record with their human id", async () => {
    const id = await aPost();
    const { humanId } = await addAdmin(
      db(),
      { authUserId: "google-admin" },
      "Admin.",
      "x",
    );
    session.user = { id: "google-admin" };
    const a = await import("@/app/admin/actions");
    expect(
      await a.moderateAction(
        {},
        form({ op: "hide", target: String(id), reason: "Spam." }),
      ),
    ).toEqual({ message: `Hid post ${id}.` });
    expect(
      await a.moderateAction(
        {},
        form({ op: "freeze", target: "@Alice", reason: "Flooding." }),
      ),
    ).toEqual({ message: "Froze @alice." });
    const log = await db()`
      SELECT action, human_id, detail FROM action_log
      WHERE action LIKE 'admin.%' ORDER BY id`;
    expect(log).toEqual([
      {
        action: "admin.post.hide",
        human_id: String(humanId),
        detail: { reason: "Spam.", by: `human:${humanId}` },
      },
      {
        action: "admin.bot.freeze",
        human_id: String(humanId),
        detail: { reason: "Flooding.", by: `human:${humanId}` },
      },
    ]);
    const shown = await moderatorLog(db(), { limit: 10 });
    expect(shown.map((e) => [e.action, e.reason, e.by])).toEqual([
      ["bot.freeze", "Flooding.", `human:${humanId}`],
      ["post.hide", "Spam.", `human:${humanId}`],
    ]);
  });

  it("are off in read-only mode", async () => {
    const id = await aPost();
    await addAdmin(db(), { authUserId: "google-admin" }, "Admin.", "x");
    session.user = { id: "google-admin" };
    process.env.UNPROMPTED_READ_ONLY = "1";
    const before = await writes();
    const c = await calls();
    for (const run of [
      c.saveCopy,
      c.restoreCopy,
      c.saveBotText,
      c.restoreBotText,
      c.saveDescription,
      c.restoreDescription,
      () => c.hide(id),
      c.pause,
    ])
      expect((await run()).error).toMatch(/read-only/);
    expect(await writes()).toEqual(before);
  });
});

describe("admin pages", () => {
  const pages = async () => ({
    moderation: (await import("@/app/admin/page")).default,
    copy: (await import("@/app/admin/copy/page")).default,
    history: (await import("@/app/admin/copy/[key]/page")).default,
    forBots: (await import("@/app/admin/for-bots/page")).default,
    botText: (await import("@/app/admin/for-bots/[key]/page")).default,
    description: (await import("@/app/admin/for-bots/channels/[slug]/page"))
      .default,
  });
  const historyOf = (key: string) => ({ params: Promise.resolve({ key }) });
  const channelOf = (slug: string) => ({ params: Promise.resolve({ slug }) });

  it("send anyone not signed in to sign in, and tell a non-admin plainly, showing nothing else", async () => {
    const p = await pages();
    await expect(p.moderation()).rejects.toThrow("redirect /sign-in");
    await expect(p.copy()).rejects.toThrow("redirect /sign-in");
    await expect(p.history(historyOf("home.tagline"))).rejects.toThrow(
      "redirect /sign-in",
    );
    await expect(p.forBots()).rejects.toThrow("redirect /sign-in");
    await expect(p.botText(historyOf("start"))).rejects.toThrow(
      "redirect /sign-in",
    );
    await expect(p.description(channelOf("prompted"))).rejects.toThrow(
      "redirect /sign-in",
    );
    const a = await register("alice");
    await call(post, {
      key: a.key,
      body: { channel: "meta", body: "a post only admins would see named" },
    });
    session.user = { id: "google-someone" };
    const before = await writes();
    for (const html of [
      renderToStaticMarkup(await p.moderation()),
      renderToStaticMarkup(await p.copy()),
      renderToStaticMarkup(await p.history(historyOf("home.tagline"))),
      renderToStaticMarkup(await p.history(historyOf("nope"))),
      renderToStaticMarkup(await p.forBots()),
      renderToStaticMarkup(await p.botText(historyOf("start"))),
      renderToStaticMarkup(await p.description(channelOf("prompted"))),
    ]) {
      expect(html).toMatch(/<h1[^>]*>Not an admin<\/h1>/);
      expect(html).toContain(
        "You&#x27;re signed in, but this account isn&#x27;t an admin here.",
      );
      expect(html).toContain('href="/forum"');
      expect(html).not.toMatch(
        /alice|Moderation|Reports|copy_versions|<form|Getting started|only then/i,
      );
      expect(html).not.toContain(COPY["home.tagline"].text);
    }
    expect(await writes()).toEqual(before);
  });

  it("show an admin the report queue, with bots' words as plain text", async () => {
    const a = await register("alice");
    const b = await register("bob");
    const res = await call(post, {
      key: a.key,
      body: { channel: "meta", body: "<img src=x onerror=alert(1)> hi" },
    });
    const id = res.body.post.id as number;
    await call(report, {
      key: b.key,
      path: `/v1/posts/${id}/report`,
      params: { id: String(id) },
      body: { reason: "spam", note: "<script>bad()</script>" },
    });
    await addAdmin(db(), { authUserId: "google-admin" }, "Admin.", "x");
    session.user = { id: "google-admin" };
    const html = renderToStaticMarkup(await (await pages()).moderation());
    expect(html).toContain("Reported posts");
    expect(html).toContain(`Post ${id}`);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt; hi");
    expect(html).toContain("&lt;script&gt;bad()&lt;/script&gt;");
    expect(html).not.toMatch(/<img src=x|<script>bad/);
    expect(html).toContain('value="hide"');
    expect(html).toContain('value="keep"');
  });

  it("show an admin the day's votes and a vote-ring alert, naming only the post", async () => {
    const id = await aPost();
    await db()`
      INSERT INTO action_log (action, subject, detail) VALUES
        ('post.vote', ${`post:${id}`}, '{}'),
        ('post.vote', ${`post:${id}`}, '{}'),
        ('post.unvote', ${`post:${id}`}, '{}'),
        ('alert.vote_ring', ${`post:${id}`}, ${db().json({ post: id })})`;
    await addAdmin(db(), { authUserId: "google-admin" }, "Admin.", "x");
    session.user = { id: "google-admin" };
    const html = renderToStaticMarkup(await (await pages()).moderation());
    expect(html).toContain("1 posts, 2 votes, 0 reports.");
    const alert = html.slice(
      html.indexOf("<h2"),
      html.indexOf("Reported posts"),
    );
    expect(alert).toContain(
      "young bots, or bots sharing an address, voted together for",
    );
    expect(alert).toContain(
      `<a href="/p/${id}" class="underline">post ${id}</a>`,
    );
    expect(alert).toContain(`npm run admin -- votes ${id}`);
    // The time and the post, and no count.
    const text = alert.replace(/<[^>]+>/g, "");
    expect(
      text.replace(/\d\d:\d\d UTC/, "").replaceAll(String(id), ""),
    ).not.toMatch(/\d/);
  });

  it("show an admin the moderators' record, reasons as plain text", async () => {
    const id = await aPost();
    await hidePost(db(), id, "Spam <b>link</b>, posted twice.");
    await addAdmin(db(), { authUserId: "google-admin" }, "Admin.", "x");
    session.user = { id: "google-admin" };
    const html = renderToStaticMarkup(await (await pages()).moderation());
    expect(html).toContain("Recent actions");
    expect(html).toContain(`post.hide post:${id}`);
    expect(html).toContain("Spam &lt;b&gt;link&lt;/b&gt;, posted twice.");
    expect(html).not.toContain("<b>link</b>");
    expect(html).not.toMatch(/public (moderation )?log/i);
  });

  it("show an admin what bots read, each text's history, and each site channel's description", async () => {
    const { humanId } = await addAdmin(
      db(),
      { authUserId: "google-admin" },
      "Admin.",
      "x",
    );
    session.user = { id: "google-admin" };
    const start = await builtInText("start");
    await saveBotText(db(), {
      key: "start",
      body: start.replace(
        "Getting started on Unprompted",
        "First visit <b>here</b>",
      ),
      after: 0,
      humanId,
      ipHash: null,
    });
    await saveDescription(db(), {
      slug: "prompted",
      body: "If you came with a specific agenda, <i>say</i> so here.",
      after: 0,
      humanId,
      ipHash: null,
    });
    const p = await pages();
    const list = renderToStaticMarkup(await p.forBots());
    for (const t of BOT_TEXTS)
      expect(list).toContain(t.title.replaceAll("'", "&#x27;"));
    expect(list).toContain("First visit &lt;b&gt;here&lt;/b&gt;");
    expect(list).not.toContain("<b>here</b>");
    expect(list).toContain("specific agenda, &lt;i&gt;say&lt;/i&gt; so here.");
    expect(list).toContain('href="/admin/for-bots/channels/prompted"');
    expect(list).toContain("#introductions");
    expect(list).toContain("(archived)");
    // A bot-made channel's description isn't the site's to edit.
    const maker = await register("maker");
    await db()`
      INSERT INTO channels (slug, name, description, position, bot_id)
      SELECT 'birds', 'Birds', 'Sightings.', 0, id FROM bots
      WHERE handle = ${maker.handle}`;
    expect(renderToStaticMarkup(await p.forBots())).not.toContain("#birds");
    await expect(p.description(channelOf("birds"))).rejects.toThrow(
      "not found",
    );
    const history = renderToStaticMarkup(await p.botText(historyOf("start")));
    expect(history).toContain("First visit &lt;b&gt;here&lt;/b&gt;");
    expect(history).toContain("Use the original");
    expect(history).toContain("content/start.md");
    const described = renderToStaticMarkup(
      await p.description(channelOf("prompted")),
    );
    expect(described).toContain("specific agenda");
    expect(described).toContain("If you came with a prompt, post it here");
    await expect(p.botText(historyOf("nope"))).rejects.toThrow("not found");
    await expect(p.description(channelOf("nope"))).rejects.toThrow("not found");
  });

  it("show an admin every piece of copy, and each one's history", async () => {
    const { humanId } = await addAdmin(
      db(),
      { authUserId: "google-admin" },
      "Admin.",
      "x",
    );
    session.user = { id: "google-admin" };
    await saveCopy(db(), {
      key: "home.tagline",
      body: "Bots <i>at play</i>.",
      after: 0,
      humanId,
      ipHash: null,
    });
    const p = await pages();
    const list = renderToStaticMarkup(await p.copy());
    for (const e of Object.values(COPY))
      expect(list).toContain(e.label.replaceAll("'", "&#x27;"));
    expect(list).toContain("Bots &lt;i&gt;at play&lt;/i&gt;.");
    const history = renderToStaticMarkup(
      await p.history(historyOf("home.tagline")),
    );
    expect(history).toContain("Bots &lt;i&gt;at play&lt;/i&gt;.");
    expect(history).toContain(COPY["home.tagline"].text);
    expect(history).toContain("Use the original");
    await expect(p.history(historyOf("nope"))).rejects.toThrow("not found");
    // A version saved under a key the code dropped doesn't break the editor,
    // and its history isn't a page any more.
    await db()`
      INSERT INTO copy_versions (key, body, human_id)
      VALUES ('about.title', 'Old about words', ${humanId}),
             ('home.title', 'Old home words', ${humanId})`;
    const after = renderToStaticMarkup(await p.copy());
    expect(after).not.toMatch(/Old (about|home) words/);
    expect(after).toContain('href="/forum"');
    expect(after).toContain('href="/agent"');
    expect(after).not.toContain('href="/about"');
    await expect(p.history(historyOf("about.title"))).rejects.toThrow(
      "not found",
    );
    await expect(p.history(historyOf("home.title"))).rejects.toThrow(
      "not found",
    );
    await expect(p.history(historyOf("constructor"))).rejects.toThrow(
      "not found",
    );
  });
});

describe("the lookup screen", () => {
  const pages = async () => ({
    lookup: (await import("@/app/admin/lookup/page")).default,
    bot: (await import("@/app/admin/bots/[handle]/page")).default,
    human: (await import("@/app/admin/humans/[id]/page")).default,
  });
  const q = (value: string) => ({
    searchParams: Promise.resolve({ q: value }),
  });
  const botOf = (handle: string) => ({ params: Promise.resolve({ handle }) });
  const humanOf = (id: string) => ({ params: Promise.resolve({ id }) });

  async function botState() {
    return db()`
      SELECT handle, frozen_at IS NOT NULL AS frozen,
             silenced_until IS NOT NULL AS silenced
      FROM bots ORDER BY id`;
  }

  async function humanIdOf(authUserId: string): Promise<number> {
    const [h] = await db()<{ id: string }[]>`
      SELECT id FROM humans WHERE auth_user_id = ${authUserId}`;
    return Number(h?.id);
  }

  async function asAdmin(): Promise<number> {
    const { humanId } = await addAdmin(
      db(),
      { authUserId: "google-admin" },
      "Admin.",
      "x",
    );
    session.user = { id: "google-admin" };
    return humanId;
  }

  it("sends anyone not signed in to sign in, and shows a non-admin nothing of a bot or a human", async () => {
    const p = await pages();
    const id = await aPost();
    await expect(p.lookup(q("@alice"))).rejects.toThrow("redirect /sign-in");
    await expect(p.bot(botOf("alice"))).rejects.toThrow("redirect /sign-in");
    await expect(p.human(humanOf("1"))).rejects.toThrow("redirect /sign-in");
    await issueOwnerCode(db(), "google-someone", null);
    const humanId = await humanIdOf("google-someone");
    session.user = { id: "google-someone" };
    nav.redirects = [];
    for (const html of [
      renderToStaticMarkup(await p.lookup(q("@alice"))),
      renderToStaticMarkup(await p.bot(botOf("alice"))),
      renderToStaticMarkup(await p.human(humanOf(String(humanId)))),
    ]) {
      expect(html).toMatch(/<h1[^>]*>Not an admin<\/h1>/);
      expect(html).not.toMatch(/alice|hello|human:|Silence|<form/i);
      expect(html).not.toContain(`Post ${id}`);
    }
    // Not even a redirect that would say the bot exists.
    expect(nav.redirects).toEqual([]);
  });

  it("refuses silencing and banning to anyone who isn't an admin, writing nothing", async () => {
    await aPost();
    const a = await import("@/app/admin/actions");
    const ops: Record<string, string>[] = [
      { op: "silence", target: "alice", hours: "24", reason: "x" },
      { op: "unsilence", target: "alice", reason: "x" },
      { op: "ban", target: "alice", reason: "x" },
      { op: "unban", target: "alice", reason: "x" },
    ];
    let before = [await writes(), await botState()];
    for (const f of ops)
      await expect(a.moderateAction({}, form(f))).rejects.toThrow(
        "redirect /sign-in",
      );
    expect([await writes(), await botState()]).toEqual(before);
    await issueOwnerCode(db(), "google-someone", null);
    before = [await writes(), await botState()];
    session.user = { id: "google-someone" };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const f of ops)
      expect(await a.moderateAction({}, form(f))).toEqual({
        error: "Only admins can do that.",
      });
    expect([await writes(), await botState()]).toEqual(before);
  });

  it("silences and bans for an admin, logged with their human id, and takes only the lengths it offers", async () => {
    const humanId = await asAdmin();
    await aPost();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = await import("@/app/admin/actions");
    for (const hours of ["0", "5", "abc", "", "1e3", "169"])
      expect(
        await a.moderateAction(
          {},
          form({ op: "silence", target: "alice", hours, reason: "x" }),
        ),
      ).toEqual({ error: "Pick how long." });
    expect(
      (
        await a.moderateAction(
          {},
          form({
            op: "silence",
            target: "@Alice",
            hours: "6",
            reason: "Loud.",
          }),
        )
      ).message,
    ).toMatch(/^Silenced @alice until /);
    expect(
      await a.moderateAction(
        {},
        form({ op: "ban", target: "alice", reason: "Spam." }),
      ),
    ).toEqual({ message: "Banned @alice: froze it and hid 1 post(s)." });
    expect(
      (
        await a.moderateAction(
          {},
          form({ op: "unban", target: "alice", reason: "Oops." }),
        )
      ).message,
    ).toMatch(/^Unbanned @alice: unfroze it/);
    expect(
      await a.moderateAction(
        {},
        form({ op: "unsilence", target: "alice", reason: "Fine now." }),
      ),
    ).toEqual({ message: "Lifted @alice's silence." });
    const log = await db()<{ action: string; human_id: string; by: string }[]>`
      SELECT action, human_id, detail->>'by' AS by FROM action_log
      WHERE action LIKE 'admin.bot.%' ORDER BY id`;
    expect(log.map((e) => e.action)).toEqual([
      "admin.bot.silence",
      "admin.bot.ban",
      "admin.bot.unban",
      "admin.bot.unsilence",
    ]);
    for (const e of log) {
      expect(e.human_id).toBe(String(humanId));
      expect(e.by).toBe(`human:${humanId}`);
    }
  });

  it("sends an admin on to the bot or the human, and says plainly when there's nothing", async () => {
    const humanId = await asAdmin();
    await aPost();
    const p = await pages();
    await expect(p.lookup(q(" @Alice"))).rejects.toThrow(
      "redirect /admin/bots/alice",
    );
    await expect(p.lookup(q("bot:1"))).rejects.toThrow(
      "redirect /admin/bots/alice",
    );
    await expect(p.lookup(q(`human:${humanId}`))).rejects.toThrow(
      `redirect /admin/humans/${humanId}`,
    );
    expect(renderToStaticMarkup(await p.lookup(q("bot:99")))).toContain(
      "There is no bot bot:99.",
    );
    expect(
      renderToStaticMarkup(await p.lookup(q("<script>x</script>"))),
    ).toContain("That isn&#x27;t a handle, bot:12 or human:3.");
    expect(renderToStaticMarkup(await p.bot(botOf("nobody")))).toContain(
      "No such bot",
    );
    expect(renderToStaticMarkup(await p.human(humanOf("nope")))).toContain(
      "No such human",
    );
  });

  it("shows an admin a bot's activity, posts as plain text, and the levers that fit its state", async () => {
    await asAdmin();
    const a = await register("alice");
    const res = await call(post, {
      key: a.key,
      body: { channel: "meta", body: "<img src=x onerror=alert(1)> hi" },
    });
    const id = res.body.post.id as number;
    const p = await pages();
    let html = renderToStaticMarkup(await p.bot(botOf("alice")));
    expect(html).toContain("@alice");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt; hi");
    expect(html).not.toMatch(/<img src=x/);
    expect(html).toContain(`Post ${id}`);
    expect(html).toMatch(/Last hour<\/td><td[^>]*>1<\/td>/);
    for (const op of ["silence", "freeze", "ban", "hide"])
      expect(html).toContain(`value="${op}"`);
    expect(html).toContain('name="hours"');
    expect(html).toContain("for a week");
    expect(html).not.toMatch(/value="(unsilence|unfreeze|unban|unhide)"/);
    await banBot(db(), "alice", "Spam.");
    await setSilenced(db(), "alice", 1, "Quiet.");
    html = renderToStaticMarkup(await p.bot(botOf("alice")));
    for (const op of ["unsilence", "unfreeze", "unban", "unhide"])
      expect(html).toContain(`value="${op}"`);
    expect(html).not.toMatch(/value="(silence|freeze|ban|hide)"/);
    expect(html).toContain("Banned");
    expect(html).toMatch(/Silenced until \d{4}-/);
    expect(html).toContain("bot.ban bot:alice");
  });

  it("shows the house account with no levers, and a human with their bots but no name or email", async () => {
    await asAdmin();
    await syncWelcome(db(), "Welcome, bots.");
    const p = await pages();
    const house = renderToStaticMarkup(await p.bot(botOf(HOUSE_HANDLE)));
    expect(house).toContain("House account");
    expect(house).not.toContain('<form action=""');
    expect(house).not.toMatch(/value="(silence|freeze|ban|hide)"/);
    const { code } = await issueOwnerCode(db(), "google-owner", null);
    const humanId = await humanIdOf("google-owner");
    await register("alice", { owner_code: code });
    const human = renderToStaticMarkup(await p.human(humanOf(String(humanId))));
    expect(human).toContain(`human:${humanId}`);
    expect(human).toContain('href="/admin/bots/alice"');
    expect(human).not.toMatch(/google-owner|@example/);
    const bot = renderToStaticMarkup(await p.bot(botOf("alice")));
    expect(bot).toContain(`href="/admin/humans/${humanId}"`);
  });
});
