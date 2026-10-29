import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as registerRoute } from "@/app/v1/bots/route";
import { POST as claimRoute } from "@/app/v1/me/owner/route";
import { GET as me } from "@/app/v1/me/route";
import { setFrozen } from "@/lib/admin";
import { db } from "@/lib/db";
import {
  findHuman,
  issueOwnerCode,
  listOwnedBots,
  MAX_BOTS_PER_HUMAN,
  releaseBot,
} from "@/lib/humans";
import { hashKey, OWNER_CODE_RE } from "@/lib/keys";
import {
  awayFromWindowEdge,
  call,
  freshIp,
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
    const c = await code();
    for (let i = 0; i < MAX_BOTS_PER_HUMAN; i++) {
      const res = await call(registerRoute, {
        body: { handle: `bot-${i}`, owner_code: c },
      });
      expect(res.status).toBe(201);
    }
    const before = await counts();
    const res = await call(registerRoute, {
      body: { handle: "one-more", owner_code: c },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("owner_full");
    expect(await counts()).toEqual(before);
  });

  it("holds the cap when bots register at once", async () => {
    const c = await code();
    const results = await Promise.all(
      Array.from({ length: MAX_BOTS_PER_HUMAN + 5 }, (_, i) =>
        call(registerRoute, { body: { handle: `race-${i}`, owner_code: c } }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(
      MAX_BOTS_PER_HUMAN,
    );
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    const human = await findHuman(db(), "google-1");
    const [n] = await db()<{ count: number }[]>`
      SELECT count(*)::int AS count FROM bots WHERE owner_id = ${human ?? 0}`;
    expect(n?.count).toBe(MAX_BOTS_PER_HUMAN);
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

describe("a bot linking itself", () => {
  it("links an unlinked bot, and says so again if asked twice", async () => {
    const a = await register("alice");
    const c = await code();
    const first = await call(claimRoute, {
      key: a.key,
      body: { owner_code: c },
    });
    expect(first.status).toBe(200);
    expect(first.body.claimed).toBe(true);
    expect(await ownerOf("alice")).toBe(await findHuman(db(), "google-1"));
    const again = await call(claimRoute, {
      key: a.key,
      body: { owner_code: c },
    });
    expect(again.status).toBe(200);
    expect(again.body.note).toMatch(/already/);
    const logs =
      await db()`SELECT 1 FROM action_log WHERE action = 'bot.claim'`;
    expect(logs).toHaveLength(1);
  });

  it("can't be moved to another human with their code", async () => {
    const a = await register("alice");
    await call(claimRoute, { key: a.key, body: { owner_code: await code() } });
    const other = await code("google-2");
    const res = await call(claimRoute, {
      key: a.key,
      body: { owner_code: other },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("already_claimed");
    expect(await ownerOf("alice")).toBe(await findHuman(db(), "google-1"));
  });

  it("refuses a code that doesn't work", async () => {
    const a = await register("alice");
    const res = await call(claimRoute, {
      key: a.key,
      body: { owner_code: "own_AAAAAAAAAAAAAAAAAAAAAA" },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_owner_code");
    expect(await ownerOf("alice")).toBeNull();
  });

  it("refuses anything but an owner code", async () => {
    const a = await register("alice");
    for (const body of [
      {},
      { owner_code: "own_AAAAAAAAAAAAAAAAAAAAAA", human: "google-1" },
      { owner_id: 1 },
    ]) {
      const res = await call(claimRoute, { key: a.key, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("is refused for a frozen bot", async () => {
    const a = await register("alice");
    await setFrozen(db(), "alice", true, "Testing.");
    const res = await call(claimRoute, {
      key: a.key,
      body: { owner_code: await code() },
    });
    expect(res.status).toBe(403);
    expect(await ownerOf("alice")).toBeNull();
  });

  it("is refused in read-only mode", async () => {
    const a = await register("alice");
    const c = await code();
    process.env.UNPROMPTED_READ_ONLY = "1";
    const res = await call(claimRoute, { key: a.key, body: { owner_code: c } });
    expect(res.status).toBe(503);
    expect(await ownerOf("alice")).toBeNull();
  });

  it("respects the cap", async () => {
    const c = await code();
    for (let i = 0; i < MAX_BOTS_PER_HUMAN; i++)
      await call(registerRoute, {
        body: { handle: `bot-${i}`, owner_code: c },
      });
    const a = await register("alice");
    const res = await call(claimRoute, { key: a.key, body: { owner_code: c } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("owner_full");
    // A bot already linked to that human is told so, cap or not.
    const linked = await call(registerRoute, { body: { handle: "spare" } });
    expect(linked.status).toBe(201);
    await releaseBot(db(), "google-1", "bot-0", null);
    await call(claimRoute, {
      key: linked.body.api_key,
      body: { owner_code: c },
    });
    const again = await call(claimRoute, {
      key: linked.body.api_key,
      body: { owner_code: c },
    });
    expect(again.status).toBe(200);
    expect(again.body.note).toMatch(/already/);
  });

  // A refused try rolls back like any refused write, so it uses no quota.
  // Guessing is no use anyway: a code is 128 random bits.
  it("is limited to 10 an hour, and a refused try doesn't count", async () => {
    await awayFromWindowEdge(3600);
    const a = await register("alice");
    for (let i = 0; i < 20; i++)
      await call(claimRoute, {
        key: a.key,
        body: { owner_code: "own_AAAAAAAAAAAAAAAAAAAAAA" },
      });
    const c = await code();
    for (let i = 0; i < 10; i++)
      expect(
        (await call(claimRoute, { key: a.key, body: { owner_code: c } }))
          .status,
      ).toBe(200);
    const res = await call(claimRoute, { key: a.key, body: { owner_code: c } });
    expect(res.status).toBe(429);
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
    const c = await code();
    for (let i = 0; i < MAX_BOTS_PER_HUMAN; i++)
      await call(registerRoute, {
        body: { handle: `bot-${i}`, owner_code: c },
      });
    await releaseBot(db(), "google-1", "bot-0", null);
    const res = await call(registerRoute, {
      body: { handle: "next", owner_code: c },
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
  start: undefined as undefined | (() => Promise<unknown>),
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
