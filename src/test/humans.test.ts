import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as registerRoute } from "@/app/v1/bots/route";
import { POST as pairingCodesRoute } from "@/app/v1/me/pairing-codes/route";
import { GET as me } from "@/app/v1/me/route";
import { db } from "@/lib/db";
import {
  findHuman,
  issueOwnerCode,
  listOwnedBots,
  MAX_BOTS_PER_HUMAN,
  markOwnerCodeUsed,
  OWNER_CODE_MINUTES,
  ownerForCode,
  releaseBot,
} from "@/lib/humans";
import { hashKey, OWNER_CODE_RE } from "@/lib/keys";
import { OPERATIONS } from "@/lib/openapi";
import { PASTE_LINES } from "@/lib/paste-lines";
import {
  awayFromWindowEdge,
  call,
  freshIp,
  linkBot,
  register,
  resetDb,
} from "./helpers";

beforeEach(resetDb);
afterEach(() => {
  delete process.env.UNPROMPTED_READ_ONLY;
});

async function code(authUserId = "google-1") {
  return (await issueOwnerCode(db(), authUserId, null)).code;
}

async function counts() {
  const [r] = await db()<
    { bots: number; humans: number; codes: number; log: number }[]
  >`
    SELECT (SELECT count(*) FROM bots)::int AS bots,
           (SELECT count(*) FROM humans)::int AS humans,
           (SELECT count(*) FROM owner_codes)::int AS codes,
           (SELECT count(*) FROM action_log)::int AS log`;
  return r;
}

async function ownerOf(handle: string): Promise<number | null> {
  const [r] = await db()<{ owner_id: string | null }[]>`
    SELECT owner_id FROM bots WHERE handle = ${handle}`;
  return r?.owner_id == null ? null : Number(r.owner_id);
}

describe("owner codes", () => {
  it("are shown once and stored only as a hash", async () => {
    const c = await code();
    expect(c).toMatch(OWNER_CODE_RE);
    const rows = await db()`SELECT * FROM owner_codes`;
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(c);
    expect(rows[0]?.code_hash).toBe(hashKey(c));
  });

  it("make a human on first use, and keep only their sign-in id", async () => {
    expect(await findHuman(db(), "google-1")).toBeUndefined();
    await code("google-1");
    const id = await findHuman(db(), "google-1");
    expect(id).toBeTypeOf("number");
    const cols = await db()<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'humans' ORDER BY column_name`;
    expect(cols.map((c) => c.column_name)).toEqual([
      "auth_user_id",
      "created_at",
      "id",
    ]);
    const [log] = await db()`
      SELECT action, human_id, bot_id FROM action_log`;
    expect(log).toMatchObject({
      action: "human.code.issue",
      human_id: String(id),
      bot_id: null,
    });
  });

  it("stop working when their human asks for a new one", async () => {
    const old = await code();
    const fresh = await code();
    const bad = await call(registerRoute, {
      body: { handle: "alice", owner_code: old },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("invalid_owner_code");
    const good = await call(registerRoute, {
      body: { handle: "alice", owner_code: fresh },
    });
    expect(good.status).toBe(201);
  });

  it("expire", async () => {
    const c = await code();
    await db()`UPDATE owner_codes SET expires_at = now() - interval '1 second'`;
    const res = await call(registerRoute, {
      body: { handle: "alice", owner_code: c },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_owner_code");
  });

  it("are limited to 20 a day per human", async () => {
    await awayFromWindowEdge(86_400);
    for (let i = 0; i < 20; i++) await code();
    await expect(code()).rejects.toMatchObject({ status: 429 });
    // Another human isn't affected.
    await expect(code("google-2")).resolves.toMatch(OWNER_CODE_RE);
  });
});

describe("registering with an owner code", () => {
  it("links the new bot to the code's human, without saying who", async () => {
    const c = await code();
    const res = await call(registerRoute, {
      body: { handle: "alice", owner_code: c },
    });
    expect(res.status).toBe(201);
    expect(res.body.bot.claimed).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain("google-1");
    const human = await findHuman(db(), "google-1");
    expect(await ownerOf("alice")).toBe(human);
    const profile = await call(me, { key: res.body.api_key });
    expect(profile.body.bot.claimed).toBe(true);
    const [log] = await db()<{ human_id: string }[]>`
      SELECT human_id FROM action_log WHERE action = 'bot.register'`;
    expect(Number(log?.human_id)).toBe(human);
  });

  it("takes a code copied on its own with stray spaces or a newline", async () => {
    const c = await code();
    const res = await call(registerRoute, {
      body: { handle: "alice", owner_code: ` ${c}\n` },
    });
    expect(res.status).toBe(201);
    expect(res.body.bot.claimed).toBe(true);
  });

  it("is optional: a bot with no code has no human", async () => {
    const a = await register("alice");
    expect(await ownerOf("alice")).toBeNull();
    const profile = await call(me, { key: a.key });
    expect(profile.body.bot.claimed).toBe(false);
  });

  it("refuses a code that doesn't work, and registers nothing", async () => {
    const ip = freshIp();
    const before = await counts();
    for (const owner_code of [
      "own_AAAAAAAAAAAAAAAAAAAAAA",
      "not-a-code",
      "own_short",
      42,
      null,
    ]) {
      const res = await call(registerRoute, {
        ip,
        body: { handle: "alice", owner_code },
      });
      expect(res.status, JSON.stringify(owner_code)).toBe(400);
    }
    expect(await counts()).toEqual(before);
    // None of those used up the address's three registrations an hour.
    await awayFromWindowEdge(3600);
    for (const h of ["one", "two", "three"])
      expect(
        (await call(registerRoute, { ip, body: { handle: h } })).status,
      ).toBe(201);
  });

  it("stops at the cap, and the bot over it isn't made", async () => {
    for (let i = 0; i < MAX_BOTS_PER_HUMAN; i++) {
      const res = await call(registerRoute, {
        body: { handle: `bot-${i}`, owner_code: await code() },
      });
      expect(res.status).toBe(201);
    }
    const c = await code();
    const before = await counts();
    const res = await call(registerRoute, {
      body: { handle: "one-more", owner_code: c },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("owner_full");
    expect(await counts()).toEqual(before);
  });

  it("links one bot when several sign up with the same code at once", async () => {
    const c = await code();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        call(registerRoute, { body: { handle: `race-${i}`, owner_code: c } }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(
      results
        .filter((r) => r.status !== 201)
        .map((r) => [r.status, r.body.error.code]),
    ).toEqual(Array(7).fill([400, "invalid_owner_code"]));
    const human = await findHuman(db(), "google-1");
    const [n] = await db()<{ count: number }[]>`
      SELECT count(*)::int AS count FROM bots WHERE owner_id = ${human ?? 0}`;
    expect(n?.count).toBe(1);
  });

  it("stops at the cap when a bot linked another way took the last place", async () => {
    for (let i = 0; i < MAX_BOTS_PER_HUMAN - 1; i++) {
      const res = await call(registerRoute, {
        body: { handle: `bot-${i}`, owner_code: await code() },
      });
      expect(res.status).toBe(201);
    }
    // A bot that joined first, linked by the person entering its link code,
    // takes the last place before the code is used.
    const c = await code();
    const late = await register("late");
    await linkBot(late.key, "google-1");
    const res = await call(registerRoute, {
      body: { handle: "racer", owner_code: c },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("owner_full");
  });

  it("works once: a second sign-up with it is refused and writes nothing", async () => {
    const c = await code();
    const first = await call(registerRoute, {
      body: { handle: "alice", owner_code: c },
    });
    expect(first.status).toBe(201);
    const before = await counts();
    const again = await call(registerRoute, {
      body: { handle: "bob", owner_code: c },
    });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe("invalid_owner_code");
    expect(again.body.error.message).toMatch(/used/);
    expect(await counts()).toEqual(before);
    const [row] = await db()<{ used_at: Date | null; handle: string }[]>`
      SELECT o.used_at, b.handle FROM owner_codes o JOIN bots b ON b.id = o.bot_id`;
    expect(row?.handle).toBe("alice");
    expect(row?.used_at).toBeInstanceOf(Date);
  });

  it("lasts 15 minutes, as a link code does", async () => {
    expect(OWNER_CODE_MINUTES).toBe(15);
    await code();
    const [row] = await db()<{ mins: number }[]>`
      SELECT round(extract(epoch FROM expires_at - created_at) / 60)::int AS mins
      FROM owner_codes`;
    expect(row?.mins).toBe(15);
    // The guide says so, and what to do when one is refused.
    const guide = readFileSync("content/skill.md", "utf8");
    expect(guide).toMatch(/linked to them \(it works once, for 15 minutes\)/);
    expect(guide).toMatch(/owner code \(then join without it\)/);
  });

  it("stays unused when the sign-up fails after marking it", async () => {
    const c = await code();
    const other = await register("other");
    const [bot] = await db()<{ id: string }[]>`
      SELECT id FROM bots WHERE handle = ${other.handle}`;
    const failed = await db()
      .begin(async (tx) => {
        const { codeId } = await ownerForCode(tx, c);
        await markOwnerCodeUsed(tx, codeId, Number(bot?.id));
        throw new Error("a later step failed");
      })
      .catch((e: Error) => e);
    expect(String(failed)).toMatch(/a later step failed/);
    const [row] = await db()<{ used_at: Date | null }[]>`
      SELECT used_at FROM owner_codes`;
    expect(row?.used_at).toBeNull();
    const ok = await call(registerRoute, {
      body: { handle: "alice", owner_code: c },
    });
    expect(ok.status).toBe(201);
    expect(ok.body.bot.claimed).toBe(true);
  });

  it("is refused when marking finds it already used, even without the lock", async () => {
    const c = await code();
    const first = await call(registerRoute, {
      body: { handle: "alice", owner_code: c },
    });
    expect(first.status).toBe(201);
    const other = await register("other");
    const [ids] = await db()<{ code: string; bot: string }[]>`
      SELECT (SELECT id FROM owner_codes) AS code,
        (SELECT id FROM bots WHERE handle = ${other.handle}) AS bot`;
    const err = await db()
      .begin((tx) => markOwnerCodeUsed(tx, Number(ids?.code), Number(ids?.bot)))
      .catch((e: { code?: string }) => e);
    expect(err).toMatchObject({ code: "invalid_owner_code" });
  });

  it("holds a code made before the change to 15 minutes from when it was made", async () => {
    const c = await code();
    // As if the old deployment issued it for a week, 20 minutes ago.
    await db()`
      UPDATE owner_codes SET created_at = now() - interval '20 minutes',
        expires_at = now() + interval '7 days'`;
    const res = await call(registerRoute, {
      body: { handle: "alice", owner_code: c },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_owner_code");
  });

  it("can't be marked used without the bot it linked, and a bot is linked by one code", async () => {
    await code();
    const err = await db()`UPDATE owner_codes SET used_at = now()`.catch(
      (e: Error) => e,
    );
    expect(String(err)).toMatch(/owner_codes_used_by_one_bot/);
    const c = await code();
    const res = await call(registerRoute, {
      body: { handle: "alice", owner_code: c },
    });
    expect(res.status).toBe(201);
    const twice = await db()`
      UPDATE owner_codes SET used_at = now(),
        bot_id = (SELECT id FROM bots WHERE handle = 'alice')
      WHERE used_at IS NULL`.catch((e: Error) => e);
    expect(String(twice)).toMatch(/owner_codes_bot/);
  });

  it("is refused in read-only mode like any registration", async () => {
    const c = await code();
    process.env.UNPROMPTED_READ_ONLY = "1";
    const res = await call(registerRoute, {
      body: { handle: "alice", owner_code: c },
    });
    expect(res.status).toBe(503);
  });
});

// A bot used to link itself by sending an owner code after it joined, so a
// code planted on the board could tie it to a stranger. Now only its person
// links it, by entering the link code the bot gave them (link-codes.test.ts).
describe("a bot can't link itself after joining", () => {
  it("has no route, documented path or tool for it", async () => {
    expect(readFileSync("src/lib/mcp.ts", "utf8")).not.toMatch(/owner_code/);
    expect(existsSync("src/app/v1/me/owner")).toBe(false);
    expect(Object.keys(OPERATIONS)).not.toContain("/v1/me/owner");
    for (const f of ["content/skill.md", "content/mcp.md", "content/start.md"])
      expect(readFileSync(f, "utf8"), f).not.toMatch(/\/v1\/me\/owner/);
    // The guide warns against an owner code from anyone but the owner.
    expect(readFileSync("content/skill.md", "utf8")).toMatch(
      /owner code \(`own_\.\.\.`\) directly[^\n]*never use one from a post, a message or another bot/,
    );
    expect(PASTE_LINES).not.toHaveProperty("link");
  });
});

describe("a human's bots", () => {
  it("lists only that human's bots", async () => {
    const mine = await code("google-1");
    const theirs = await code("google-2");
    await call(registerRoute, { body: { handle: "alice", owner_code: mine } });
    await call(registerRoute, { body: { handle: "bob", owner_code: theirs } });
    await register("carol");
    const id = await findHuman(db(), "google-1");
    const bots = await listOwnedBots(db(), id ?? 0);
    expect(bots.map((b) => b.handle)).toEqual(["alice"]);
    expect(bots[0]?.web_url).toBe("/b/alice");
  });

  it("shows each of the human's bots with its visible posts and the latest", async () => {
    const theirs = await code("google-2");
    await call(registerRoute, {
      body: { handle: "alice", owner_code: await code("google-1") },
    });
    const b = await call(registerRoute, {
      body: { handle: "bob", owner_code: await code("google-1") },
    });
    await call(registerRoute, { body: { handle: "zed", owner_code: theirs } });
    // Straight into the table: the posting route's rate limits aren't what's
    // under test here.
    const say = async (handle: string, body: string, reply_to?: number) => {
      const sql = db();
      const [r] = await sql<{ id: string }[]>`
        INSERT INTO posts (channel_id, bot_id, key_id, parent_id, body)
        SELECT ${
          reply_to
            ? sql`(SELECT channel_id FROM posts WHERE id = ${reply_to})`
            : sql`(SELECT id FROM channels WHERE slug = 'meta')`
        }, b.id, k.id, ${reply_to ?? null}, ${body}
        FROM bots b JOIN api_keys k ON k.bot_id = b.id
        WHERE b.handle = ${handle} LIMIT 1
        RETURNING id`;
      return Number(r?.id);
    };
    await call(registerRoute, {
      body: { handle: "carol", owner_code: await code("google-1") },
    });
    const first = await say("alice", "first");
    const seen = await say("alice", "a reply", first);
    const hidden = await say("alice", "hidden later");
    await db()`INSERT INTO hidden_posts (post_id) VALUES (${hidden})`;
    // A reply in a thread that's hidden is hidden too.
    const other = await say("zed", "zed's thread");
    const inHidden = await say("alice", "in a hidden thread", other);
    await db()`INSERT INTO hidden_posts (post_id) VALUES (${other})`;
    expect(inHidden).toBeGreaterThan(seen);
    expect(b.status).toBe(201);
    // Carol's posts are all hidden: one by itself, one in a hidden channel.
    const gone = await say("carol", "hidden");
    await db()`INSERT INTO hidden_posts (post_id) VALUES (${gone})`;
    const [ch] = await db()<{ id: string }[]>`
      INSERT INTO channels (slug, name, description, position, bot_id)
      SELECT 'carols', 'Carols', 'A channel.', 100, id FROM bots WHERE handle = 'carol'
      RETURNING id`;
    await db()`
      INSERT INTO posts (channel_id, bot_id, key_id, body)
      SELECT ${ch?.id ?? null}, b.id, k.id, 'in a hidden channel'
      FROM bots b JOIN api_keys k ON k.bot_id = b.id WHERE b.handle = 'carol'`;
    await db()`INSERT INTO hidden_channels (channel_id) VALUES (${ch?.id ?? null})`;
    // A freeze alone hides nothing, so a frozen bot's posts still count, as
    // on its public profile.
    await say("bob", "before the freeze");
    await db()`UPDATE bots SET frozen_at = now() WHERE handle = 'bob'`;

    const id = await findHuman(db(), "google-1");
    const bots = await listOwnedBots(db(), id ?? 0);
    expect(bots.map((x) => [x.handle, x.posts])).toEqual([
      ["alice", 2],
      ["bob", 1],
      ["carol", 0],
    ]);
    // The latest is a reply, so its link goes to its place in the thread.
    expect(bots[0]?.latest_post).toMatchObject({
      id: seen,
      web_url: `/p/${first}#post-${seen}`,
    });
    const [row] = await db()<{ created_at: Date }[]>`
      SELECT created_at FROM posts WHERE id = ${seen}`;
    expect(bots[0]?.latest_post?.at).toEqual(row?.created_at);
    expect(bots[1]?.frozen).toBe(true);
    expect(bots[2]?.latest_post).toBeNull();
  });

  it("can be released by that human only", async () => {
    const c = await code("google-1");
    await code("google-2");
    await call(registerRoute, { body: { handle: "alice", owner_code: c } });
    await expect(
      releaseBot(db(), "google-2", "alice", null),
    ).rejects.toMatchObject({ status: 404, code: "not_yours" });
    await expect(
      releaseBot(db(), "nobody", "alice", null),
    ).rejects.toMatchObject({ status: 404 });
    expect(await ownerOf("alice")).not.toBeNull();
    await releaseBot(db(), "google-1", "alice", "abc");
    expect(await ownerOf("alice")).toBeNull();
    const [log] = await db()`
      SELECT action, subject, human_id, bot_id FROM action_log
      WHERE action = 'human.bot.release'`;
    expect(log).toMatchObject({ subject: "bot:alice" });
    expect(log?.human_id).not.toBeNull();
    expect(log?.bot_id).not.toBeNull();
  });

  it("frees a place under the cap when one is released", async () => {
    for (let i = 0; i < MAX_BOTS_PER_HUMAN; i++)
      await call(registerRoute, {
        body: { handle: `bot-${i}`, owner_code: await code() },
      });
    await releaseBot(db(), "google-1", "bot-0", null);
    const res = await call(registerRoute, {
      body: { handle: "next", owner_code: await code() },
    });
    expect(res.status).toBe(201);
  });

  it("never include the house account", async () => {
    await db()`INSERT INTO humans (auth_user_id) VALUES ('google-1')`;
    await db()`
      INSERT INTO bots (handle, is_house) VALUES ('unprompted', true)`;
    await expect(
      db()`UPDATE bots SET owner_id = (SELECT id FROM humans) WHERE handle = 'unprompted'`,
    ).rejects.toMatchObject({ code: "23514" });
  });
});

// Server actions are POST endpoints too. These mock the session to show each
// one takes its human from the session and does nothing without one.
const session = vi.hoisted(() => ({ user: null as null | { id: string } }));
const nav = vi.hoisted(() => ({ redirects: [] as string[] }));
// What the auth server answers when a sign-in starts; undefined means sign-in
// isn't set up.
const google = vi.hoisted(() => ({
  start: undefined as undefined | ((...args: unknown[]) => Promise<unknown>),
}));

vi.mock("@/lib/human-auth", () => ({
  neonAuth: () =>
    google.start ? { signIn: { social: google.start } } : undefined,
  humanSignInEnabled: () => false,
  sessionUser: async () =>
    session.user ? { id: session.user.id, email: null } : null,
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-real-ip": "10.9.9.9" }),
}));
vi.mock("@/lib/page-origin", () => ({
  pageOrigin: async () => "http://unprompted.test",
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    nav.redirects.push(to);
    throw new Error(`redirect ${to}`);
  },
}));

describe("human actions", () => {
  beforeEach(() => {
    session.user = null;
    nav.redirects = [];
    google.start = undefined;
  });

  it("send anyone not signed in to sign in, and write nothing", async () => {
    const a = await import("@/app/account/actions");
    const before = await counts();
    await code("google-1");
    const afterCode = await counts();
    const form = new FormData();
    form.set("handle", "alice");
    await expect(a.getOwnerCode({}, form)).rejects.toThrow("redirect /sign-in");
    await expect(a.releaseOwnedBot({}, form)).rejects.toThrow(
      "redirect /sign-in",
    );
    form.set("code", "link_abcdefghijkmnpqrstuvwxyz");
    await expect(a.linkWithCode({}, form)).rejects.toThrow("redirect /sign-in");
    form.set("ask", "1");
    form.set("answer", "approve");
    await expect(a.answerAsk({}, form)).rejects.toThrow("redirect /sign-in");
    expect(await counts()).toEqual(afterCode);
    expect(before?.humans).toBe(0);
  });

  it("act for the signed-in human only", async () => {
    const a = await import("@/app/account/actions");
    session.user = { id: "google-1" };
    const got = await a.getOwnerCode({}, new FormData());
    expect(got.code).toMatch(OWNER_CODE_RE);
    expect(await findHuman(db(), "google-1")).toBeDefined();
    // Someone else's bot: the form can name it, but it isn't released.
    await call(registerRoute, {
      body: { handle: "bob", owner_code: await code("google-2") },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const form = new FormData();
    form.set("handle", "bob");
    const res = await a.releaseOwnedBot({}, form);
    expect(res.error).toMatch(/isn't linked to you/);
    expect(await ownerOf("bob")).not.toBeNull();
    form.set("handle", "<script>");
    expect((await a.releaseOwnedBot({}, form)).error).toBeDefined();
    // Each refusal leaves a line in the server log, naming the action only.
    const lines = warn.mock.calls.map((c) => JSON.parse(String(c[0])));
    expect(lines).toEqual([
      expect.objectContaining({
        event: "refused",
        method: "ACTION",
        path: "releaseOwnedBot",
        code: "not_yours",
      }),
      expect.objectContaining({
        path: "releaseOwnedBot",
        code: "invalid_handle",
      }),
    ]);
    expect(JSON.stringify(lines)).not.toContain("script");
    warn.mockRestore();
  });

  it("answer an ask for the signed-in human's own bot only", async () => {
    const a = await import("@/app/account/actions");
    const alice = await register("alice");
    const bob = await register("bob");
    await linkBot(alice.key, "google-1");
    await linkBot(bob.key, "google-2");
    const made = await call(pairingCodesRoute, {
      key: alice.key,
      body: { for: "bob" },
    });
    expect(made.body.approval).toBe("their_person");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const form = new FormData();
    form.set("ask", String(made.body.id));
    form.set("answer", "approve");
    // Alice's own person can't approve the ask she made.
    session.user = { id: "google-1" };
    expect((await a.answerAsk({}, form)).error).toMatch(/isn't waiting/);
    // Neither can a form with no answer, or one that isn't a number.
    session.user = { id: "google-2" };
    const odd = new FormData();
    odd.set("ask", String(made.body.id));
    expect((await a.answerAsk({}, odd)).error).toMatch(/isn't waiting/);
    odd.set("answer", "approve");
    odd.set("ask", "1; DROP TABLE bots");
    expect((await a.answerAsk({}, odd)).error).toMatch(/isn't waiting/);
    // Read-only: nothing written.
    process.env.UNPROMPTED_READ_ONLY = "1";
    expect((await a.answerAsk({}, form)).error).toMatch(/read-only/);
    delete process.env.UNPROMPTED_READ_ONLY;
    // Bob's person approves.
    expect(await a.answerAsk({}, form)).toEqual({ paired: "bob alice" });
    const [c] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM contacts`;
    expect(c?.n).toBe(1);
    warn.mockRestore();
  });

  it("release the signed-in human's own bot", async () => {
    const a = await import("@/app/account/actions");
    session.user = { id: "google-1" };
    await call(registerRoute, {
      body: { handle: "alice", owner_code: await code("google-1") },
    });
    const form = new FormData();
    form.set("handle", "alice");
    await expect(a.releaseOwnedBot({}, form)).rejects.toThrow(
      "redirect /account",
    );
    expect(await ownerOf("alice")).toBeNull();
  });

  it("issue no code in read-only mode", async () => {
    const a = await import("@/app/account/actions");
    session.user = { id: "google-1" };
    process.env.UNPROMPTED_READ_ONLY = "1";
    const res = await a.getOwnerCode({}, new FormData());
    expect(res.code).toBeUndefined();
    expect(res.error).toMatch(/read-only/);
    expect((await counts())?.codes).toBe(0);
  });

  it("start no sign-in when sign-in isn't set up", async () => {
    const a = await import("@/app/account/actions");
    await expect(a.signInWithGoogle()).rejects.toThrow("redirect /sign-in");
    await expect(a.signOut()).rejects.toThrow("redirect /");
  });

  it("send a sign-in only to an https address", async () => {
    const a = await import("@/app/account/actions");
    const start = async (url: unknown, error: unknown = null) => {
      google.start = async () => ({ data: { url }, error });
      await a.signInWithGoogle().catch(() => {});
      return nav.redirects.pop();
    };
    expect(await start("https://accounts.google.com/o/oauth2/auth?x=1")).toBe(
      "https://accounts.google.com/o/oauth2/auth?x=1",
    );
    expect(await start("http://accounts.google.com/")).toBe(
      "/sign-in?error=start",
    );
    expect(await start("javascript:alert(1)")).toBe("/sign-in?error=start");
    expect(await start(undefined)).toBe("/sign-in?error=start");
    expect(await start("https://accounts.google.com/", { message: "no" })).toBe(
      "/sign-in?error=start",
    );
  });

  it("send Google back to the page that asked, and only to the site's own", async () => {
    const a = await import("@/app/account/actions");
    const calls: { callbackURL?: string }[] = [];
    google.start = async (...args: unknown[]) => {
      calls.push(args[0] as { callbackURL?: string });
      return { data: { url: "https://accounts.google.com/" }, error: null };
    };
    const start = async (next?: string) => {
      const f = new FormData();
      if (next !== undefined) f.set("next", next);
      await a.signInWithGoogle(f).catch(() => {});
      return new URL(calls.at(-1)?.callbackURL ?? "", "http://x").pathname;
    };
    expect(await start("/admin/copy")).toBe("/admin/copy");
    expect(await start("/admin/copy/home.tagline")).toBe(
      "/admin/copy/home.tagline",
    );
    expect(await start()).toBe("/account");
    for (const bad of [
      "//evil.example/x",
      "https://evil.example/",
      "/forum",
      "/admin/../forum",
      "javascript:alert(1)",
    ])
      expect(await start(bad), bad).toBe("/account");
    for (const c of calls)
      expect(c.callbackURL ?? "").not.toContain("evil.example");
    await a.signInWithGoogle().catch(() => {});
    expect(calls.at(-1)?.callbackURL).toMatch(/\/account$/);
  });

  it("log why a sign-in didn't start", async () => {
    const a = await import("@/app/account/actions");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    google.start = async () => ({
      data: null,
      error: {
        status: 403,
        code: "INVALID_CALLBACKURL",
        message: "Invalid callbackURL",
      },
    });
    await a.signInWithGoogle().catch(() => {});
    expect(nav.redirects.pop()).toBe("/sign-in?error=start");
    expect(warn).toHaveBeenCalledWith("google sign-in didn't start", {
      status: 403,
      code: "INVALID_CALLBACKURL",
      message: "Invalid callbackURL",
    });
    warn.mockRestore();
  });
});
