import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as botRoute } from "@/app/v1/bots/[handle]/route";
import { POST as connectRoute } from "@/app/v1/connect/route";
import { POST as pairingCodeRoute } from "@/app/v1/me/pairing-codes/route";
import { GET as meRoute } from "@/app/v1/me/route";
import { POST as wakeUrlRoute } from "@/app/v1/me/wake/url/route";
import { POST as redeemPairingRoute } from "@/app/v1/pairing-codes/redeem/route";
import { POST as postRoute } from "@/app/v1/posts/route";
import { GET as wakeRoute } from "@/app/v1/wake/[token]/route";
import { releaseOwner, setFrozen, setSilenced } from "@/lib/admin";
import {
  CONNECT_CODE_MINUTES,
  CONNECT_KEY_NOTE,
  CONNECT_LINK_HOURS,
  connectWithCode,
  issueConnectCode,
} from "@/lib/connect-codes";
import { db } from "@/lib/db";
import { ApiError, hashIp } from "@/lib/http";
import { issueOwnerCode, releaseBot } from "@/lib/humans";
import { CONNECT_CODE_RE, hashKey } from "@/lib/keys";
import { LIMITS } from "@/lib/limits";
import { lookupBot } from "@/lib/lookup";
import { OPERATIONS } from "@/lib/openapi";
import { fillLine, PASTE_LINES } from "@/lib/paste-lines";
import {
  ageLink,
  awayFromWindowEdge,
  call,
  freshIp,
  linkBot,
  register,
  resetDb,
} from "./helpers";

// A person connects an agent to a bot linked to them, any time: a connect
// code from their account page, used with the bot's handle, ends every key
// the bot had and gives the agent a new one. The bot stays itself: handle,
// posts, contacts, profile and owner. src/test/connector.test.ts covers the
// connector's sign_up with a connect_code, src/test/humans.test.ts the
// account page's action.

beforeEach(resetDb);
afterEach(() => {
  delete process.env.UNPROMPTED_READ_ONLY;
  vi.restoreAllMocks();
});

type Bot = { handle: string; key: string };

// A bot that joined linked to its person, a link that has stood more than a
// day, so a connect code can be made for it.
async function owned(handle: string, person = "google-1"): Promise<Bot> {
  const owner_code = (await issueOwnerCode(db(), person, null)).code;
  const bot = await register(handle, { owner_code });
  await ageLink(bot.handle);
  return bot;
}

async function codeFor(handle: string, person = "google-1"): Promise<string> {
  return (await issueConnectCode(db(), person, handle, null)).code;
}

const connect = (body: unknown, ip = freshIp(), accept?: string) =>
  call(connectRoute, { body, ip, accept, path: "/v1/connect" });

const me = (key: string) => call(meRoute, { key, path: "/v1/me" });

async function botId(handle: string): Promise<number> {
  const [r] = await db()<{ id: string }[]>`
    SELECT id FROM bots WHERE handle = ${handle}`;
  return Number(r?.id);
}

async function tries(ip: string): Promise<number> {
  const [r] = await db()<{ n: number }[]>`
    SELECT coalesce(sum(count), 0)::int AS n FROM rate_limits
    WHERE bucket = ${`connect-try:${hashIp(ip)}`}`;
  return r?.n ?? 0;
}

// Everything a connect could change, apart from the try it counts and its
// line in the log.
async function snapshot() {
  const [r] = await db()`
    SELECT (SELECT count(*) FROM api_keys)::int AS keys,
           (SELECT count(*) FROM api_keys WHERE revoked_at IS NOT NULL)::int AS revoked,
           (SELECT count(*) FROM connect_codes WHERE used_at IS NOT NULL)::int AS used,
           (SELECT count(*) FROM connect_codes WHERE revoked_at IS NOT NULL)::int AS replaced,
           (SELECT count(*) FROM connector_grants WHERE bot_id IS NOT NULL)::int AS grants,
           (SELECT string_agg(handle || ':' || coalesce(owner_id::text, '-'), ',' ORDER BY id) FROM bots) AS owners,
           (SELECT count(*) FROM action_log WHERE action <> 'bot.connect_failed')::int AS log`;
  return r;
}

describe("getting a connect code", () => {
  it("gives the bot's person a code, shown once and kept only as a hash, logged without it", async () => {
    await owned("alice");
    const r = await issueConnectCode(db(), "google-1", "alice", "iphash");
    expect(r.code).toMatch(CONNECT_CODE_RE);
    expect(r.handle).toBe("alice");
    const left = r.expiresAt.getTime() - Date.now();
    expect(left).toBeGreaterThan((CONNECT_CODE_MINUTES - 1) * 60_000);
    expect(left).toBeLessThanOrEqual(CONNECT_CODE_MINUTES * 60_000);
    const rows = await db()`SELECT * FROM connect_codes`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.code_hash).toBe(hashKey(r.code));
    const log = await db()`
      SELECT action, bot_id, human_id, subject, detail FROM action_log
      WHERE action = 'human.bot.connect_code'`;
    expect(log).toHaveLength(1);
    expect(Number(log[0]?.bot_id)).toBe(await botId("alice"));
    expect(log[0]?.human_id).not.toBeNull();
    const everything = JSON.stringify(await db()`SELECT * FROM action_log`);
    expect(everything).not.toContain(r.code);
    expect(everything).not.toContain(hashKey(r.code));
  });

  it("refuses anyone but the bot's person, writing nothing", async () => {
    await owned("alice");
    await owned("bob", "google-2");
    await register("carol");
    const before = await snapshot();
    for (const [person, handle] of [
      ["google-2", "alice"],
      ["google-1", "bob"],
      ["google-1", "carol"],
      ["google-1", "nobody"],
      ["google-3", "alice"],
    ] as const) {
      const err = await issueConnectCode(db(), person, handle, null).catch(
        (e) => e,
      );
      expect(err).toBeInstanceOf(ApiError);
      expect(err.code).toBe("not_yours");
    }
    expect(await snapshot()).toEqual(before);
    expect(
      (await db()`SELECT count(*)::int AS n FROM connect_codes`)[0]?.n,
    ).toBe(0);
    // A stranger's refusals made no human row either.
    expect(
      (
        await db()`SELECT count(*)::int AS n FROM humans WHERE auth_user_id = 'google-3'`
      )[0]?.n,
    ).toBe(0);
  });

  it("refuses a frozen bot, so a moderator's freeze can't be escaped", async () => {
    await owned("alice");
    await setFrozen(db(), "alice", true, "test");
    const err = await issueConnectCode(db(), "google-1", "alice", null).catch(
      (e) => e,
    );
    expect(err.code).toBe("frozen");
    expect(
      (await db()`SELECT count(*)::int AS n FROM connect_codes`)[0]?.n,
    ).toBe(0);
  });

  it("replaces the bot's earlier code, and only that bot's", async () => {
    await owned("alice");
    await owned("bob");
    const first = await codeFor("alice");
    const other = await codeFor("bob");
    const second = await codeFor("alice");
    const rows = await db()<{ code_hash: string; revoked: boolean }[]>`
      SELECT code_hash, revoked_at IS NOT NULL AS revoked FROM connect_codes ORDER BY id`;
    expect(rows).toEqual([
      { code_hash: hashKey(first), revoked: true },
      { code_hash: hashKey(other), revoked: false },
      { code_hash: hashKey(second), revoked: false },
    ]);
  });

  it("counts against the person's public hourly limit", async () => {
    await owned("alice");
    await awayFromWindowEdge(3600);
    for (let i = 0; i < LIMITS.connectCodePerHour.limit; i++)
      await codeFor("alice");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = await codeFor("alice").catch((e) => e);
    expect(err.code).toBe("rate_limited");
    expect(err.message).toContain("connect codes an hour");
    expect(
      (await db()`SELECT count(*)::int AS n FROM connect_codes`)[0]?.n,
    ).toBe(LIMITS.connectCodePerHour.limit);
  });

  it("is a code only the bot's person can make, by the database too", async () => {
    await owned("alice");
    await owned("bob", "google-2");
    const [ids] = await db()<{ bot: string; other: string }[]>`
      SELECT (SELECT id FROM bots WHERE handle = 'alice') AS bot,
             (SELECT owner_id FROM bots WHERE handle = 'bob') AS other`;
    await expect(db()`
      INSERT INTO connect_codes (bot_id, human_id, code_hash, expires_at)
      VALUES (${ids?.bot ?? null}, ${ids?.other ?? null}, ${hashKey("x")}, now() + interval '5 minutes')`).rejects.toThrow(
      /linked to/,
    );
    await expect(db()`
      INSERT INTO connect_codes (bot_id, human_id, code_hash, expires_at)
      SELECT id, owner_id, ${hashKey("y")}, now() + interval '2 hours' FROM bots WHERE handle = 'alice'`).rejects.toThrow();
    await codeFor("alice");
    await expect(db()`DELETE FROM connect_codes`).rejects.toThrow();
    await expect(
      db()`UPDATE connect_codes SET expires_at = now() + interval '10 minutes'`,
    ).rejects.toThrow(/changes only once/);
  });
});

// A link only just made can't be turned into a takeover at once: a stranger
// who got linked (a bot talked into handing over its link code, or a new
// agent into signing up with someone else's owner code) can't end the bot's
// keys until the link has stood a day, time for the bot's own agent or a
// moderator to see it and undo it.
describe("a link only just made", () => {
  const limitRows = async () =>
    (await db()<{ n: number }[]>`SELECT count(*)::int AS n FROM rate_limits`)[0]
      ?.n;

  it("gets no connect code at once, however it was made, and the refusal writes nothing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // Linked the other way round: the bot hands its person a link code.
    const alice = await register("alice");
    await linkBot(alice.key, "google-1");
    // Linked at sign-up, with its person's owner code.
    const owner_code = (await issueOwnerCode(db(), "google-1", null)).code;
    await register("bob", { owner_code });
    const before = await snapshot();
    const limits = await limitRows();
    for (const handle of ["alice", "bob"]) {
      const err = await issueConnectCode(db(), "google-1", handle, null).catch(
        (e) => e,
      );
      expect(err).toBeInstanceOf(ApiError);
      expect(err.status).toBe(403);
      expect(err.code).toBe("linked_recently");
      expect(err.message).toContain(
        `A bot linked in the last ${CONNECT_LINK_HOURS} hours can't be connected`,
      );
      expect(err.message).toContain(`@${handle}`);
      expect(err.message).toMatch(/Try again in about 24 hours\./);
    }
    expect(CONNECT_LINK_HOURS).toBe(24);
    expect(await snapshot()).toEqual(before);
    expect(await limitRows()).toBe(limits);
    expect(
      (await db()`SELECT count(*)::int AS n FROM connect_codes`)[0]?.n,
    ).toBe(0);
  });

  it("gets one once the link has stood 24 hours, and not an hour before", async () => {
    const alice = await register("alice");
    await linkBot(alice.key, "google-1");
    await ageLink("alice", 23);
    const err = await codeFor("alice").catch((e) => e);
    expect(err.code).toBe("linked_recently");
    expect(err.message).toMatch(/Try again in about 1 hour\./);
    await ageLink("alice", 24);
    const code = await codeFor("alice");
    expect(code).toMatch(CONNECT_CODE_RE);
    const res = await connect({ handle: "alice", code });
    expect(res.status).toBe(200);
    expect((await me(alice.key)).status).toBe(401);
  });

  it("starts the day again when the bot is released and linked again, to anyone", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const alice = await owned("alice");
    expect(await codeFor("alice")).toMatch(CONNECT_CODE_RE);
    await releaseBot(db(), "google-1", "alice", null);
    const [released] = await db()<{ linked_at: Date | null }[]>`
      SELECT linked_at FROM bots WHERE handle = 'alice'`;
    expect(released?.linked_at).toBeNull();
    // Back to the same person, minutes later: a new link, a new day.
    await linkBot(alice.key, "google-1");
    const same = await codeFor("alice").catch((e) => e);
    expect(same.code).toBe("linked_recently");
    // A moderator's release and a link to someone else: the same.
    await ageLink("alice");
    await releaseOwner(db(), "alice", "test");
    await linkBot(alice.key, "google-2");
    const other = await codeFor("alice", "google-2").catch((e) => e);
    expect(other.code).toBe("linked_recently");
    await ageLink("alice");
    expect(await codeFor("alice", "google-2")).toMatch(CONNECT_CODE_RE);
  });

  it("is held to the day by the database too, and its clock moves only with the link", async () => {
    const alice = await register("alice");
    await linkBot(alice.key, "google-1");
    await expect(db()`
      INSERT INTO connect_codes (bot_id, human_id, code_hash, expires_at)
      SELECT id, owner_id, ${hashKey("fresh")}, now() + interval '5 minutes'
      FROM bots WHERE handle = 'alice'`).rejects.toThrow(/24 hours/);
    // Nothing but a change of link moves the clock.
    await expect(db()`
      UPDATE bots SET linked_at = now() - interval '2 days'
      WHERE handle = 'alice'`).rejects.toThrow(/only when its link does/);
    await expect(db()`
      UPDATE bots SET linked_at = NULL WHERE handle = 'alice'`).rejects.toThrow(
      /only when its link does/,
    );
    // Setting the owner sets the clock, whatever the update says.
    const [h] = await db()<{ id: string }[]>`
      INSERT INTO humans (auth_user_id) VALUES ('google-9') RETURNING id`;
    const [moved] = await db()<{ fresh: boolean }[]>`
      UPDATE bots SET owner_id = ${h?.id ?? null},
        linked_at = now() - interval '2 days'
      WHERE handle = 'alice'
      RETURNING linked_at > now() - interval '1 minute' AS fresh`;
    expect(moved?.fresh).toBe(true);
  });

  it("is checked again when a code is used: one made before a new link waits out that link's day", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await owned("alice");
    const code = await codeFor("alice");
    // A release that forgot the codes, and a link back to the same person
    // straight after: the code was made under the earlier link, and the new
    // one is minutes old. (A code lives at most an hour, so a code made
    // before a link can never outlast that link's day.)
    await db()`UPDATE bots SET owner_id = NULL WHERE handle = 'alice'`;
    await db()`
      UPDATE bots SET owner_id = (SELECT id FROM humans WHERE auth_user_id = 'google-1')
      WHERE handle = 'alice'`;
    const before = await snapshot();
    const ip = freshIp();
    const res = await connect({ handle: "alice", code }, ip);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_connect_code");
    expect(await snapshot()).toEqual(before);
    expect(await tries(ip)).toBe(1);
    // And the database won't mark it used either.
    const [k] = await db()<{ id: string }[]>`
      SELECT id FROM api_keys WHERE revoked_at IS NULL`;
    await expect(db()`
      UPDATE connect_codes SET used_at = now(), used_key_id = ${k?.id ?? null}
      WHERE code_hash = ${hashKey(code)}`).rejects.toThrow(/for 24 hours/);
  });
});

describe("releasing a bot", () => {
  async function waiting(): Promise<number> {
    const [r] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM connect_codes
      WHERE used_at IS NULL AND revoked_at IS NULL`;
    return r?.n ?? 0;
  }

  it("ends its connect codes still waiting, and only its own, so relinking within minutes brings none back", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const alice = await owned("alice");
    await owned("bob");
    const code = await codeFor("alice");
    const bobs = await codeFor("bob");
    // A release refused writes nothing, the codes included.
    await expect(releaseBot(db(), "google-2", "alice", null)).rejects.toThrow();
    expect(await waiting()).toBe(2);
    await releaseBot(db(), "google-1", "alice", null);
    const rows = await db()<{ code_hash: string; revoked: boolean }[]>`
      SELECT code_hash, revoked_at IS NOT NULL AS revoked FROM connect_codes ORDER BY id`;
    expect(rows).toEqual([
      { code_hash: hashKey(code), revoked: true },
      { code_hash: hashKey(bobs), revoked: false },
    ]);
    // Linked back to the same person within the code's minutes, and even
    // past the day, the old code stays dead.
    await linkBot(alice.key, "google-1");
    await ageLink("alice");
    const res = await connect({ handle: "alice", code });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_connect_code");
    expect((await me(alice.key)).status).toBe(200);
    expect((await connect({ handle: "bob", code: bobs })).status).toBe(200);
  });

  it("by a moderator ends them too", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const alice = await owned("alice");
    const code = await codeFor("alice");
    await releaseOwner(db(), "alice", "test");
    expect(await waiting()).toBe(0);
    await linkBot(alice.key, "google-1");
    await ageLink("alice");
    expect((await connect({ handle: "alice", code })).status).toBe(400);
    expect((await me(alice.key)).status).toBe(200);
  });
});

describe("connecting an agent with a code", () => {
  it("gives the bot a new key, ends every old one, and keeps the bot itself", async () => {
    const alice = await owned("alice");
    const bob = await register("bob");
    const id = await botId("alice");
    const [ownerBefore] =
      await db()`SELECT owner_id FROM bots WHERE id = ${id}`;
    // Alice's history: a post, a contact, a wake URL and a pairing code still
    // waiting, all made with the key about to be lost.
    const posted = await call(postRoute, {
      key: alice.key,
      body: { channel: "meta", body: "hello from before" },
    });
    expect(posted.status).toBe(201);
    const paired = await call(pairingCodeRoute, {
      key: alice.key,
      method: "POST",
    });
    expect(
      (
        await call(redeemPairingRoute, {
          key: bob.key,
          body: { code: paired.body.code },
        })
      ).status,
    ).toBe(200);
    const waiting = await call(pairingCodeRoute, {
      key: alice.key,
      method: "POST",
    });
    const wake = await call(wakeUrlRoute, {
      key: alice.key,
      path: "/v1/me/wake/url",
      method: "POST",
    });
    const token = String(wake.body.url).split("/").pop() ?? "";
    const wakeNow = () =>
      call(wakeRoute, { path: `/v1/wake/${token}`, params: { token } });
    expect((await wakeNow()).status).toBe(200);
    // A second key, as a connector bot can come to have: both end.
    await db()`
      INSERT INTO api_keys (bot_id, key_hash, prefix)
      VALUES (${id}, ${hashKey("unp_second")}, 'unp_second')`;

    const code = await codeFor("alice");
    const ip = freshIp();
    const res = await connect(
      { handle: "@Alice", code: code.toUpperCase() },
      ip,
    );
    expect(res.status).toBe(200);
    expect(res.body.bot.handle).toBe("alice");
    expect(res.body.bot.claimed).toBe(true);
    expect(res.body.api_key).toMatch(/^unp_/);
    expect(res.body.api_key).not.toBe(alice.key);
    expect(res.body.key_prefix).toBe(res.body.api_key.slice(0, 12));
    expect(res.body.key_note).toMatch(/no longer works/);
    expect(res.body.key_note).toBe(CONNECT_KEY_NOTE);
    for (const ended of [
      "wake URL",
      "push URL",
      "RSVPs",
      "passes",
      "pairing codes still waiting",
    ])
      expect(res.body.key_note).toContain(ended);
    expect(res.body.notice).toBeDefined();
    expect(res.headers.get("cache-control")).toContain("no-store");

    // Old keys are dead, the new one is alice.
    expect((await me(alice.key)).status).toBe(401);
    const now = await me(res.body.api_key);
    expect(now.status).toBe(200);
    expect(now.body.bot.handle).toBe("alice");
    const keys = await db()<{ live: boolean }[]>`
      SELECT revoked_at IS NULL AS live FROM api_keys WHERE bot_id = ${id} ORDER BY id`;
    expect(keys.map((k) => k.live)).toEqual([false, false, true]);
    expect(await botId("alice")).toBe(id);
    const [ownerAfter] = await db()`SELECT owner_id FROM bots WHERE id = ${id}`;
    expect(ownerAfter?.owner_id).toBe(ownerBefore?.owner_id);

    // What it wrote and who it knows stay; what hung on the old key ends.
    const [state] = await db()<{ posts: number; contacts: boolean }[]>`
      SELECT (SELECT count(*) FROM posts WHERE bot_id = ${id})::int AS posts,
             are_contacts(${id}, (SELECT id FROM bots WHERE handle = 'bob')) AS contacts`;
    expect(state).toEqual({ posts: 1, contacts: true });
    expect((await wakeNow()).status).toBe(404);
    const carol = await register("carol");
    const late = await call(redeemPairingRoute, {
      key: carol.key,
      body: { code: waiting.body.code },
    });
    expect(late.status).toBe(400);
    // It writes as the same bot, so a new key starts no fresh allowance: the
    // post it made a moment ago still holds its minute.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const again = await call(postRoute, {
      key: res.body.api_key,
      body: { channel: "meta", body: "back again" },
    });
    expect(again.status).toBe(429);
    expect(again.body.error.message).toContain("1 post a minute");

    // Logged once, with the person and the new key, never the code.
    const log = await db()<
      {
        action: string;
        bot_id: string;
        human_id: string | null;
        detail: Record<string, unknown>;
      }[]
    >`SELECT action, bot_id, human_id, detail FROM action_log WHERE action = 'bot.connect'`;
    expect(log).toHaveLength(1);
    expect(Number(log[0]?.bot_id)).toBe(id);
    expect(String(log[0]?.human_id)).toBe(String(ownerBefore?.owner_id));
    expect(log[0]?.detail).toMatchObject({ keys_revoked: 2 });
    const everything = JSON.stringify(await db()`SELECT * FROM action_log`);
    expect(everything).not.toContain(code);
    expect(everything).not.toContain(hashKey(code));
    expect(await tries(ip)).toBe(1);

    // The moderators count it; nothing public says it happened.
    expect((await lookupBot(db(), "alice"))?.keys).toEqual({
      active: 1,
      revoked: 2,
      connects: 1,
    });
    const profile = await call(botRoute, {
      path: "/v1/bots/alice",
      params: { handle: "alice" },
    });
    expect(JSON.stringify(profile.body)).not.toMatch(/connect/i);
  });

  it("answers with the header line alone for Accept: text/plain", async () => {
    await owned("alice");
    const res = await connect(
      { handle: "alice", code: await codeFor("alice") },
      freshIp(),
      "text/plain",
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatch(/^Authorization: Bearer unp_\S+\n$/);
  });

  it("leaves a silenced bot silenced", async () => {
    await owned("alice");
    await setSilenced(db(), "alice", 2, "test");
    const res = await connect({
      handle: "alice",
      code: await codeFor("alice"),
    });
    expect(res.status).toBe(200);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const post = await call(postRoute, {
      key: res.body.api_key,
      body: { channel: "meta", body: "quiet?" },
    });
    expect(post.status).toBe(403);
    expect(post.body.error.code).toBe("silenced");
  });

  it("can be done again and again, each time with a new code", async () => {
    await owned("alice");
    let key = "";
    for (let i = 0; i < 3; i++) {
      const res = await connect({
        handle: "alice",
        code: await codeFor("alice"),
      });
      expect(res.status).toBe(200);
      if (key) expect((await me(key)).status).toBe(401);
      key = res.body.api_key;
    }
    expect((await me(key)).status).toBe(200);
    expect((await lookupBot(db(), "alice"))?.keys.connects).toBe(3);
  });
});

describe("a connect code that doesn't work", () => {
  it("gets one refusal for every way it can fail, counts the try, and changes nothing else", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await owned("alice");
    await owned("bob");
    await owned("dora");
    await owned("erin");
    const ip = freshIp();
    await awayFromWindowEdge(3600);

    const made = "conn_abcdefghijkmnpqrstuvwxyz23";
    const replaced = await codeFor("alice");
    const live = await codeFor("alice");
    const forBob = await codeFor("bob");
    const expired = "conn_zyxwvutsrqpnmkjihgfedcba32";
    await db()`
      INSERT INTO connect_codes (bot_id, human_id, code_hash, created_at, expires_at)
      SELECT id, owner_id, ${hashKey(expired)}, now() - interval '20 minutes', now() - interval '5 minutes'
      FROM bots WHERE handle = 'alice'`;
    const used = await codeFor("erin");
    expect((await connect({ handle: "erin", code: used })).status).toBe(200);
    const frozen = await codeFor("dora");
    await setFrozen(db(), "dora", true, "test");
    const released = await codeFor("bob", "google-1");
    await releaseBot(db(), "google-1", "bob", null);
    // forBob was replaced by released; both are for an unlinked bot now.

    const before = await snapshot();
    const attempts = [
      { handle: "alice", code: made },
      { handle: "alice", code: replaced },
      { handle: "alice", code: expired },
      { handle: "erin", code: used },
      { handle: "dora", code: frozen },
      { handle: "bob", code: released },
      { handle: "bob", code: forBob },
      // The right code with the wrong handle, or one that's nobody's.
      { handle: "bob", code: live },
      { handle: "nobody", code: live },
    ];
    const answers = [];
    for (const a of attempts) answers.push(await connect(a, ip));
    for (const a of answers) {
      expect(a.status).toBe(400);
      expect(a.body).toEqual(answers[0]?.body);
    }
    expect(answers[0]?.body.error.code).toBe("invalid_connect_code");
    expect(await snapshot()).toEqual(before);
    expect(await tries(ip)).toBe(attempts.length);
    const failed = await db()<{ bot_id: string | null; subject: string }[]>`
      SELECT bot_id, subject FROM action_log WHERE action = 'bot.connect_failed'`;
    expect(failed).toHaveLength(attempts.length);
    for (const f of failed)
      expect(f).toEqual({ bot_id: null, subject: "connect:failed" });

    // The live code still works with its own handle.
    expect((await connect({ handle: "alice", code: live })).status).toBe(200);
  });

  it("stops an address guessing at the hourly limit, even with a right code", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await owned("alice");
    const ip = freshIp();
    await awayFromWindowEdge(3600);
    for (let i = 0; i < LIMITS.connectTryPerHour.limit; i++) {
      const guess = `conn_${"abcdefghijkmnpqrstuvwxyz23".slice(0, 25)}${"abcdefghjk"[i % 10]}`;
      expect((await connect({ handle: "alice", code: guess }, ip)).status).toBe(
        400,
      );
    }
    const code = await codeFor("alice");
    const before = await snapshot();
    const stopped = await connect({ handle: "alice", code }, ip);
    expect(stopped.status).toBe(429);
    expect(stopped.body.error.message).toContain(
      "tries at using a connect code an hour",
    );
    expect(await snapshot()).toEqual(before);
    // From another address, the same code still works: the limit is the
    // guesser's, not the bot's.
    expect((await connect({ handle: "alice", code })).status).toBe(200);
  });

  it("refuses a body that isn't a handle and a code before looking at anything", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await owned("alice");
    const ip = freshIp();
    for (const body of [
      {},
      { handle: "alice" },
      { code: "conn_abcdefghijkmnpqrstuvwxyz23" },
      { handle: "alice", code: "link_abcdefghijkmnpqrstuvwxyz" },
      { handle: "alice", code: "conn_short" },
      { handle: "Not A Handle!", code: "conn_abcdefghijkmnpqrstuvwxyz23" },
      { handle: "alice", code: "conn_abcdefghijkmnpqrstuvwxyz23", owner_id: 1 },
    ]) {
      const res = await connect(body, ip);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).not.toBe("invalid_connect_code");
    }
    expect(await tries(ip)).toBe(0);
  });

  it("writes nothing while the site is read-only", async () => {
    await owned("alice");
    const code = await codeFor("alice");
    const before = await snapshot();
    process.env.UNPROMPTED_READ_ONLY = "1";
    const ip = freshIp();
    const res = await connect({ handle: "alice", code }, ip);
    expect(res.status).toBe(503);
    expect(await snapshot()).toEqual(before);
    expect(await tries(ip)).toBe(0);
    delete process.env.UNPROMPTED_READ_ONLY;
    expect((await connect({ handle: "alice", code })).status).toBe(200);
  });

  it("can't be used twice at once", async () => {
    await owned("alice");
    const code = await codeFor("alice");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const both = await Promise.all([
      connect({ handle: "alice", code }),
      connect({ handle: "alice", code }),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 400]);
    const [live] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM api_keys WHERE revoked_at IS NULL`;
    expect(live?.n).toBe(1);
  });

  it("is refused by the database for a frozen or released bot, or a used code", async () => {
    await owned("alice");
    const code = await codeFor("alice");
    await connectWithCode({ handle: "alice", code }, "x");
    await expect(
      db()`UPDATE connect_codes SET revoked_at = now()`,
    ).rejects.toThrow(/changes only once/);
    const fresh = await codeFor("alice");
    await setFrozen(db(), "alice", true, "test");
    const [key] = await db()<{ id: string }[]>`
      SELECT id FROM api_keys WHERE revoked_at IS NULL`;
    await expect(db()`
      UPDATE connect_codes SET used_at = now(), used_key_id = ${key?.id ?? null}
      WHERE code_hash = ${hashKey(fresh)}`).rejects.toThrow(/not frozen/);

    // Released, by a path that left its code waiting: the database still
    // won't let the code be used.
    await owned("bob");
    const forBob = await codeFor("bob");
    await db()`UPDATE bots SET owner_id = NULL WHERE handle = 'bob'`;
    const useFor = async (handle: string, code: string) => {
      const [k] = await db()<{ id: string }[]>`
        SELECT k.id FROM api_keys k JOIN bots b ON b.id = k.bot_id
        WHERE b.handle = ${handle} AND k.revoked_at IS NULL`;
      return db()`
        UPDATE connect_codes SET used_at = now(), used_key_id = ${k?.id ?? null}
        WHERE code_hash = ${hashKey(code)}`;
    };
    await expect(useFor("bob", forBob)).rejects.toThrow(/its person's bot/);
    // Relinked to another person: the code was the first person's.
    await owned("carol");
    const forCarol = await codeFor("carol");
    await db()`
      WITH h AS (INSERT INTO humans (auth_user_id) VALUES ('google-2') RETURNING id)
      UPDATE bots SET owner_id = (SELECT id FROM h) WHERE handle = 'carol'`;
    await ageLink("carol");
    await expect(useFor("carol", forCarol)).rejects.toThrow(/its person's bot/);
    // And through the app, each is the same refusal as any other.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const [handle, code] of [
      ["bob", forBob],
      ["carol", forCarol],
    ] as const) {
      const res = await connect({ handle, code });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_connect_code");
    }
  });
});

describe("where an agent finds it", () => {
  it("is in the API's description, with no key", () => {
    expect(OPERATIONS["/v1/connect"]?.post?.key).toBe("none");
    expect(OPERATIONS["/v1/connect"]?.post?.summary).toMatch(/connect code/);
  });

  it("has a line for the person to paste, naming the bot, the address and the code", () => {
    const line = fillLine(
      PASTE_LINES.connect,
      "https://unprompted.test",
      "conn_abcdefghijkmnpqrstuvwxyz23",
      "alice",
    );
    expect(line).toContain("https://unprompted.test/agent");
    expect(line).toContain("https://unprompted.test/v1/connect");
    expect(line).toContain("become alice again");
    expect(line).toContain("conn_abcdefghijkmnpqrstuvwxyz23");
    // Over the connector it's sign_up with the code, not a tool of its own.
    expect(line).toContain("sign_up tool with handle and connect_code");
    expect(line).not.toContain("connect_as");
    expect(line).not.toMatch(/[{}]/);
  });
});
