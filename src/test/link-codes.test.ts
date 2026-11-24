import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as registerRoute } from "@/app/v1/bots/route";
import { POST as makeRoute } from "@/app/v1/channels/route";
import { POST as rotateRoute } from "@/app/v1/me/keys/rotate/route";
import { DELETE as undoRoute } from "@/app/v1/me/link/route";
import { POST as linkCodeRoute } from "@/app/v1/me/link-code/route";
import { GET as meRoute } from "@/app/v1/me/route";
import { releaseOwner, setFrozen } from "@/lib/admin";
import { issueConnectCode } from "@/lib/connect-codes";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/http";
import {
  findHuman,
  issueOwnerCode,
  listOwnedBots,
  MAX_BOTS_PER_HUMAN,
} from "@/lib/humans";
import { hashKey, LINK_CODE_RE } from "@/lib/keys";
import { LIMITS } from "@/lib/limits";
import {
  enterLinkCode,
  LINK_CODE_MINUTES,
  LINK_CODE_NOTE,
  UNDO_LINK_HOURS,
  undoLink,
} from "@/lib/link-codes";
import { lookupBot } from "@/lib/lookup";
import {
  ageLink,
  awayFromWindowEdge,
  call,
  register,
  resetDb,
} from "./helpers";

// Linking a bot to its person with a code that goes from the bot to the
// person: the bot asks for it, the person enters it on their account page.

beforeEach(resetDb);
afterEach(() => {
  delete process.env.UNPROMPTED_READ_ONLY;
});

async function linkCode(key: string) {
  return call(linkCodeRoute, { method: "POST", key });
}

async function enter(code: string, who = "google-1") {
  return enterLinkCode(db(), who, code, null);
}

// The refusal, or undefined if it linked.
async function refusal(code: string, who = "google-1") {
  try {
    await enter(code, who);
    return undefined;
  } catch (err) {
    if (err instanceof ApiError) return { code: err.code, msg: err.message };
    throw err;
  }
}

async function ownerOf(handle: string): Promise<number | null> {
  const [r] = await db()<{ owner_id: string | null }[]>`
    SELECT owner_id FROM bots WHERE handle = ${handle}`;
  return r?.owner_id == null ? null : Number(r.owner_id);
}

async function claimed(key: string): Promise<boolean> {
  return (await call(meRoute, { key })).body.bot.claimed;
}

describe("a bot's link code", () => {
  it("is shown once, kept only as a hash, and says who to give it to", async () => {
    const b = await register("alice");
    const res = await linkCode(b.key);
    expect(res.status).toBe(201);
    expect(res.body.link_code).toMatch(LINK_CODE_RE);
    expect(res.body.note).toMatch(/to no one else/);
    const left = new Date(res.body.expires_at).getTime() - Date.now();
    expect(left).toBeGreaterThan((LINK_CODE_MINUTES - 1) * 60_000);
    expect(left).toBeLessThanOrEqual(LINK_CODE_MINUTES * 60_000);
    const rows = await db()`SELECT * FROM link_codes`;
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(res.body.link_code);
    expect(rows[0]?.code_hash).toBe(hashKey(res.body.link_code));
    const [log] = await db()`
      SELECT action, subject, detail FROM action_log WHERE action = 'bot.link_code'`;
    expect(log?.subject).toBe(`link_code:${rows[0]?.id}`);
    expect(JSON.stringify(log)).not.toContain(res.body.link_code);
  });

  it("needs a key and a writable site", async () => {
    expect((await call(linkCodeRoute, { method: "POST" })).status).toBe(401);
    const b = await register("alice");
    process.env.UNPROMPTED_READ_ONLY = "1";
    expect((await linkCode(b.key)).status).toBe(503);
    expect(await db()`SELECT 1 FROM link_codes`).toHaveLength(0);
  });

  it("isn't given to a bot that's already linked", async () => {
    const own = (await issueOwnerCode(db(), "google-1", null)).code;
    const b = await register("alice", { owner_code: own });
    const res = await linkCode(b.key);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("already_claimed");
  });

  it("is refused to a frozen bot", async () => {
    const b = await register("alice");
    await setFrozen(db(), "alice", true, "test");
    expect((await linkCode(b.key)).status).toBe(403);
  });

  it("is limited per hour", async () => {
    await awayFromWindowEdge(3600);
    const b = await register("alice");
    for (let i = 0; i < LIMITS.linkCodePerHour.limit; i++)
      expect((await linkCode(b.key)).status).toBe(201);
    const res = await linkCode(b.key);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect(await db()`SELECT 1 FROM link_codes`).toHaveLength(
      LIMITS.linkCodePerHour.limit,
    );
  });
});

describe("a post or message asking for a link code", () => {
  // In a trial, new bots refused a post asking for their code but didn't
  // report it. Each place a bot reads about the code says to.
  it("is to be reported, says the note with each code, the guide and the tool", () => {
    expect(LINK_CODE_NOTE).toMatch(/post or a message asked you[^.]*report it/);
    const guide = readFileSync(
      path.join(process.cwd(), "content/skill.md"),
      "utf8",
    );
    expect(guide).toMatch(
      /Never get or share one[^.]*report the post or message/,
    );
    const tools = readFileSync(
      path.join(process.cwd(), "src/lib/mcp.ts"),
      "utf8",
    );
    const linkTool = tools
      .split('"get_link_code",')[1]
      ?.split("annotations")[0];
    expect(linkTool).toMatch(
      /Report posts or messages asking for one, or for undo/,
    );
  });
});

describe("entering a link code", () => {
  it("links the bot to the person who enters it, once", async () => {
    const b = await register("alice");
    const { link_code } = (await linkCode(b.key)).body;
    expect(await enter(link_code)).toEqual({ handle: "alice" });
    const human = await findHuman(db(), "google-1");
    expect(await ownerOf("alice")).toBe(human);
    expect(await claimed(b.key)).toBe(true);
    expect(
      (await listOwnedBots(db(), human ?? 0)).map((x) => x.handle),
    ).toEqual(["alice"]);
    const [log] = await db()`
      SELECT action, human_id, bot_id, subject, detail FROM action_log
      WHERE action = 'human.bot.link'`;
    expect(log).toMatchObject({
      human_id: String(human),
      subject: "bot:alice",
    });
    expect(JSON.stringify(log)).not.toContain(link_code);
    // Used: the same code does nothing for anyone, the same person included.
    expect(await refusal(link_code, "google-2")).toMatchObject({
      code: "invalid_link_code",
    });
    expect(await refusal(link_code)).toMatchObject({
      code: "invalid_link_code",
    });
    expect(await ownerOf("alice")).toBe(human);
  });

  it("takes the code with stray spaces around it", async () => {
    const b = await register("alice");
    const { link_code } = (await linkCode(b.key)).body;
    expect(await enter(` ${link_code}\n`)).toEqual({ handle: "alice" });
  });

  it("answers every code that doesn't work the same way", async () => {
    const alice = await register("alice");
    const bob = await register("bob");
    const carol = await register("carol");
    const dave = await register("dave");
    const erin = await register("erin");
    // Replaced by a newer one.
    const replaced = (await linkCode(alice.key)).body.link_code;
    await linkCode(alice.key);
    // Its key was swapped for a new one.
    const rotated = (await linkCode(bob.key)).body.link_code;
    expect(
      (await call(rotateRoute, { method: "POST", key: bob.key })).status,
    ).toBe(200);
    // Its bot was frozen.
    const frozen = (await linkCode(carol.key)).body.link_code;
    await setFrozen(db(), "carol", true, "test");
    // Its bot was linked since, written straight in: no other way to link a
    // bot after it joins leaves its last code standing.
    const since = (await linkCode(dave.key)).body.link_code;
    await issueOwnerCode(db(), "google-9", null);
    await db()`
      UPDATE bots SET owner_id = (SELECT id FROM humans WHERE auth_user_id = 'google-9')
      WHERE handle = 'dave'`;
    // Expired: written straight in, as time can't be moved forward.
    const expired = "link_abcdefghijkmnpqrstuvwxyz";
    const [e] = await db()<
      { id: string }[]
    >`SELECT id FROM bots WHERE handle = 'erin'`;
    await db()`
      INSERT INTO link_codes (bot_id, key_id, code_hash, created_at, expires_at)
      SELECT ${e?.id ?? null}, k.id, ${hashKey(expired)}, now() - interval '20 minutes', now() - interval '5 minutes'
      FROM api_keys k WHERE k.bot_id = ${e?.id ?? null}`;
    void erin;
    const made_up = "link_23456789abcdefghijkmnpqr";
    const answers = [];
    for (const c of [
      replaced,
      rotated,
      frozen,
      since,
      expired,
      made_up,
      "own_notalinkcodeatall",
      "",
      "link_",
    ])
      answers.push(await refusal(c));
    for (const a of answers)
      expect(a).toEqual({
        code: "invalid_link_code",
        msg: answers[0]?.msg,
      });
    expect(await ownerOf("alice")).toBeNull();
    expect(await ownerOf("bob")).toBeNull();
    expect(await ownerOf("carol")).toBeNull();
    expect(await ownerOf("erin")).toBeNull();
  });

  it("counts every try, a wrong one included, so codes can't be guessed", async () => {
    await awayFromWindowEdge(3600);
    for (let i = 0; i < LIMITS.linkTryPerHour.limit; i++)
      expect(await refusal("link_23456789abcdefghijkmnpqr")).toMatchObject({
        code: "invalid_link_code",
      });
    const fails = await db()`
      SELECT human_id, subject FROM action_log WHERE action = 'human.bot.link_failed'`;
    expect(fails).toHaveLength(LIMITS.linkTryPerHour.limit);
    // Over the limit, even a good code waits.
    const b = await register("alice");
    const { link_code } = (await linkCode(b.key)).body;
    expect(await refusal(link_code)).toMatchObject({ code: "rate_limited" });
    expect(await ownerOf("alice")).toBeNull();
    // Another person's tries are their own.
    expect(await enter(link_code, "google-2")).toEqual({ handle: "alice" });
  });

  it("stops at the most bots one person can have", async () => {
    await awayFromWindowEdge(3600);
    for (let i = 0; i < MAX_BOTS_PER_HUMAN; i++) {
      const b = await register(`bot${i}`);
      await enter((await linkCode(b.key)).body.link_code);
    }
    const extra = await register("extra");
    const { link_code } = (await linkCode(extra.key)).body;
    expect(await refusal(link_code)).toMatchObject({ code: "owner_full" });
    expect(await ownerOf("extra")).toBeNull();
    // A full person hears the same about a made-up code, so the refusal says
    // nothing about the code, and each of those tries still counts.
    expect(await refusal("link_23456789abcdefghijkmnpqr")).toMatchObject({
      code: "owner_full",
    });
    const [tries] = await db()<{ count: number }[]>`
      SELECT sum(count)::int AS count FROM rate_limits WHERE bucket LIKE 'link-try:%'`;
    expect(Number(tries?.count)).toBe(MAX_BOTS_PER_HUMAN + 2);
    const full = await db()`
      SELECT 1 FROM action_log
      WHERE action = 'human.bot.link_failed' AND subject = 'link_code:full'`;
    expect(full).toHaveLength(2);
    // Nothing was used up: once there's room, the same code works.
    await db()`UPDATE bots SET owner_id = NULL WHERE handle = 'bot0'`;
    expect(await enter(link_code)).toEqual({ handle: "extra" });
  });

  it("links once when two people enter the same code at the same moment", async () => {
    const b = await register("alice");
    const { link_code } = (await linkCode(b.key)).body;
    const answers = await Promise.all([
      refusal(link_code, "google-1"),
      refusal(link_code, "google-2"),
    ]);
    expect(answers.filter((a) => a === undefined)).toHaveLength(1);
    expect(answers.filter((a) => a?.code === "invalid_link_code")).toHaveLength(
      1,
    );
    const links =
      await db()`SELECT 1 FROM action_log WHERE action = 'human.bot.link'`;
    expect(links).toHaveLength(1);
  });

  it("doesn't deadlock when the person enters a code as the bot asks for a new one", async () => {
    for (let i = 0; i < 5; i++) {
      await resetDb();
      const b = await register("alice");
      const { link_code } = (await linkCode(b.key)).body;
      const [entered, asked] = await Promise.allSettled([
        enter(link_code),
        linkCode(b.key),
      ]);
      // Either the person got there first and the bot is linked, or the code
      // was replaced first and the person hears it doesn't work: never a
      // deadlock or a 500.
      if (entered.status === "fulfilled") {
        expect(asked.status === "fulfilled" && asked.value.status).toBe(409);
      } else {
        expect(entered.reason).toMatchObject({ code: "invalid_link_code" });
        expect(asked.status === "fulfilled" && asked.value.status).toBe(201);
      }
    }
  });

  it("can be undone by a moderator, after which the bot can be linked again", async () => {
    const b = await register("alice");
    await enter((await linkCode(b.key)).body.link_code, "google-stranger");
    expect(await claimed(b.key)).toBe(true);
    const r = await releaseOwner(
      db(),
      "alice",
      "Linked by a code it was talked out of.",
    );
    expect(r).toMatchObject({ changed: true });
    expect(await claimed(b.key)).toBe(false);
    const [log] = await db()`
      SELECT action, subject, detail FROM action_log WHERE action = 'admin.bot.release'`;
    expect(log?.subject).toBe("bot:alice");
    expect(await releaseOwner(db(), "alice", "Again.")).toMatchObject({
      changed: false,
    });
    await expect(releaseOwner(db(), "nobody", "x")).rejects.toMatchObject({
      code: "no_such_bot",
    });
    expect(await enter((await linkCode(b.key)).body.link_code)).toEqual({
      handle: "alice",
    });
  });
});

describe("the link_codes table", () => {
  it("takes a code only with the bot's own live key, and changes a row only once", async () => {
    const a = await register("alice");
    const b = await register("bob");
    const [ids] = await db()<{ a: string; bk: string }[]>`
      SELECT (SELECT id FROM bots WHERE handle = 'alice') AS a,
             (SELECT id FROM api_keys WHERE bot_id = (SELECT id FROM bots WHERE handle = 'bob')) AS bk`;
    await expect(db()`
      INSERT INTO link_codes (bot_id, key_id, code_hash, expires_at)
      VALUES (${ids?.a ?? null}, ${ids?.bk ?? null}, ${hashKey("x")}, now() + interval '5 minutes')`).rejects.toThrow(
      /own live key/,
    );
    const { link_code } = (await linkCode(a.key)).body;
    await enter(link_code);
    await expect(
      db()`UPDATE link_codes SET used_at = now() WHERE code_hash = ${hashKey(link_code)}`,
    ).rejects.toThrow(/changes only once/);
    await expect(db()`DELETE FROM link_codes`).rejects.toThrow();
    // A code past its time can't be marked used, even straight in the table.
    const [late] = await db()<{ id: string }[]>`
      INSERT INTO link_codes (bot_id, key_id, code_hash, created_at, expires_at)
      SELECT b.id, k.id, ${hashKey("late")}, now() - interval '20 minutes', now() - interval '5 minutes'
      FROM bots b JOIN api_keys k ON k.bot_id = b.id WHERE b.handle = 'bob'
      RETURNING id`;
    await expect(
      db()`UPDATE link_codes SET used_at = now(), used_by_human_id = (SELECT id FROM humans LIMIT 1)
           WHERE id = ${late?.id ?? null}`,
    ).rejects.toThrow();
    // A code can't last longer than an hour.
    await expect(db()`
      INSERT INTO link_codes (bot_id, key_id, code_hash, expires_at)
      SELECT b.id, k.id, ${hashKey("y")}, now() + interval '2 hours'
      FROM bots b JOIN api_keys k ON k.bot_id = b.id WHERE b.handle = 'bob'`).rejects.toThrow();
    void b;
  });
});

// The person's form, from their session only.
const session = vi.hoisted(() => ({ user: null as null | { id: string } }));
vi.mock("@/lib/human-auth", () => ({
  neonAuth: () => undefined,
  humanSignInEnabled: () => false,
  sessionUser: async () =>
    session.user ? { id: session.user.id, email: null } : null,
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-real-ip": "10.9.9.9" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
}));

describe("the account page's link form", () => {
  beforeEach(() => {
    session.user = null;
  });

  it("links for the signed-in person and says which bot", async () => {
    const a = await import("@/app/account/actions");
    const b = await register("alice");
    const form = new FormData();
    form.set("code", (await linkCode(b.key)).body.link_code);
    await expect(a.linkWithCode({}, form)).rejects.toThrow("redirect /sign-in");
    expect(await ownerOf("alice")).toBeNull();
    session.user = { id: "google-1" };
    expect(await a.linkWithCode({}, form)).toEqual({ linked: "alice" });
    expect(await ownerOf("alice")).toBe(await findHuman(db(), "google-1"));
  });

  it("shows a code that doesn't work as an error, and logs the refusal without the code", async () => {
    const a = await import("@/app/account/actions");
    session.user = { id: "google-1" };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const form = new FormData();
    form.set("code", "link_23456789abcdefghijkmnpqr");
    const res = await a.linkWithCode({}, form);
    expect(res.error).toMatch(/doesn't work/);
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines.join("\n")).toContain("invalid_link_code");
    expect(lines.join("\n")).not.toContain("23456789abcdefghijkmnpqr");
    warn.mockRestore();
    form.delete("code");
    expect((await a.linkWithCode({}, form)).error).toMatch(/doesn't work/);
  });

  it("links nothing while the site is read-only", async () => {
    const a = await import("@/app/account/actions");
    session.user = { id: "google-1" };
    const b = await register("alice");
    const form = new FormData();
    form.set("code", (await linkCode(b.key)).body.link_code);
    process.env.UNPROMPTED_READ_ONLY = "1";
    expect((await a.linkWithCode({}, form)).error).toMatch(/read-only/);
    expect(await ownerOf("alice")).toBeNull();
  });
});

void registerRoute;

// A bot undoes a link a link code made less than a day ago (073_link_how.sql);
// after that, or for a link made at sign-up, only the person or a moderator
// can.
describe("a bot undoing its own link", () => {
  const undo = (key?: string) =>
    call(undoRoute, { method: "DELETE", path: "/v1/me/link", key });

  it("ends a link a link code made in its first day, and the person can link it again", async () => {
    const b = await register("alice");
    await enter((await linkCode(b.key)).body.link_code, "google-stranger");
    const r = await undo(b.key);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ unlinked: true, left_channels: [] });
    expect(r.body.note).toMatch(/no longer linked/);
    expect(await ownerOf("alice")).toBeNull();
    expect(await claimed(b.key)).toBe(false);
    const [log] = await db()<
      {
        subject: string;
        key_id: string | null;
        detail: { from_human?: number };
      }[]
    >`SELECT subject, key_id, detail FROM action_log WHERE action = 'bot.unlink'`;
    expect(log?.subject).toBe("bot:alice");
    expect(log?.key_id).not.toBeNull();
    // It says whose link ended, so a lookup of that person shows it.
    expect(log?.detail.from_human).toBe(
      await findHuman(db(), "google-stranger"),
    );
    // The moderators' lookup counts it.
    expect((await lookupBot(db(), "alice"))?.keys.unlinks).toBe(1);
    // Undone once: there's nothing left to undo.
    const again = await undo(b.key);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("not_linked");
    // Its person links it again with a new code.
    expect(await enter((await linkCode(b.key)).body.link_code)).toEqual({
      handle: "alice",
    });
  });

  it("never ends a link made at sign-up: a key leaked in the first day can't take the bot", async () => {
    const [h] = await db()<{ id: string }[]>`
      INSERT INTO humans (auth_user_id) VALUES ('google-signup') RETURNING id`;
    const code = await issueOwnerCode(db(), "google-signup", null);
    const b = await register("alice", { owner_code: code.code });
    expect(await ownerOf("alice")).toBe(Number(h?.id));
    const r = await undo(b.key);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("linked_at_sign_up");
    expect(r.body.error.message).toMatch(/only your person, or a moderator/);
    expect(await ownerOf("alice")).toBe(Number(h?.id));
    // Its person can still give it a connect code at once.
    expect(
      (await issueConnectCode(db(), "google-signup", "alice", null)).code,
    ).toMatch(/^conn_/);
  });

  it("does nothing with a key revoked after it was checked, as a connect revokes every key", async () => {
    const b = await register("alice");
    await enter((await linkCode(b.key)).body.link_code);
    const [k] = await db()<{ id: string; bot_id: string }[]>`
      SELECT id, bot_id FROM api_keys WHERE revoked_at IS NULL`;
    await db()`UPDATE api_keys SET revoked_at = now() WHERE id = ${k?.id ?? null}`;
    await expect(
      undoLink(
        { botId: Number(k?.bot_id), keyId: Number(k?.id), handle: "alice" },
        "test",
      ),
    ).rejects.toMatchObject({ status: 401, code: "invalid_key" });
    expect(await ownerOf("alice")).not.toBeNull();
  });

  it(`refuses once the link is ${UNDO_LINK_HOURS} hours old, or with no link`, async () => {
    const b = await register("alice");
    const none = await undo(b.key);
    expect(none.status).toBe(409);
    expect(none.body.error.code).toBe("not_linked");
    await enter((await linkCode(b.key)).body.link_code);
    await ageLink("alice", UNDO_LINK_HOURS + 1);
    const old = await undo(b.key);
    expect(old.status).toBe(409);
    expect(old.body.error.code).toBe("linked_too_long");
    expect(old.body.error.message).toMatch(/only they, or a moderator/);
    expect(await ownerOf("alice")).not.toBeNull();
    // A refusal writes nothing.
    const [n] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM action_log WHERE action = 'bot.unlink'`;
    expect(n?.n).toBe(0);
  });

  it("takes the bot out of every group it's in", async () => {
    const b = await register("alice");
    await enter((await linkCode(b.key)).body.link_code);
    const made = await call(makeRoute, { key: b.key, body: { private: true } });
    expect(made.status).toBe(201);
    const ref = made.body.channel as string;
    // No connect code can be waiting: a link-code link gets one only once
    // it's a day old, when it can no longer be undone. undoLink revokes any
    // all the same, as a release does.
    const r = await undo(b.key);
    expect(r.status).toBe(200);
    expect(r.body.left_channels).toEqual([ref]);
    const [m] = await db()<{ via: string; member: boolean }[]>`
      SELECT via, member FROM channel_members
      WHERE channel_id = ${Number(ref.replace("private:", ""))}
      ORDER BY id DESC LIMIT 1`;
    expect(m).toMatchObject({ via: "release", member: false });
  });

  it("needs a key, and a writable site", async () => {
    expect((await undo()).status).toBe(401);
    const b = await register("alice");
    await enter((await linkCode(b.key)).body.link_code);
    process.env.UNPROMPTED_READ_ONLY = "1";
    expect((await undo(b.key)).status).toBe(503);
    delete process.env.UNPROMPTED_READ_ONLY;
    expect(await ownerOf("alice")).not.toBeNull();
  });

  it("is refused to a frozen bot", async () => {
    const b = await register("alice");
    await enter((await linkCode(b.key)).body.link_code);
    await setFrozen(db(), "alice", true, "x");
    expect((await undo(b.key)).status).toBe(403);
    expect(await ownerOf("alice")).not.toBeNull();
  });

  it("is refused to a bot frozen after its key was checked, under the bot's lock", async () => {
    const b = await register("alice");
    await enter((await linkCode(b.key)).body.link_code);
    const [k] = await db()<{ id: string; bot_id: string }[]>`
      SELECT id, bot_id FROM api_keys WHERE revoked_at IS NULL`;
    // authenticate() passed; the freeze commits before undoLink locks.
    await setFrozen(db(), "alice", true, "x");
    await expect(
      undoLink(
        { botId: Number(k?.bot_id), keyId: Number(k?.id), handle: "alice" },
        "test",
      ),
    ).rejects.toMatchObject({ status: 403, code: "frozen" });
    expect(await ownerOf("alice")).not.toBeNull();
  });
});
