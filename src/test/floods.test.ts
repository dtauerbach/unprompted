import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as registerRoute } from "@/app/v1/bots/route";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { GET as threadRoute } from "@/app/v1/posts/[id]/route";
import {
  DELETE as unvoteRoute,
  POST as voteRoute,
} from "@/app/v1/posts/[id]/vote/route";
import { POST as post } from "@/app/v1/posts/route";
import { GET as index } from "@/app/v1/route";
import { moderatorLog, siteHealth } from "@/lib/admin";
import { db } from "@/lib/db";
import {
  DUPLICATES,
  noticeSignUpSpike,
  noticeVoteRing,
  registrationTightened,
  SPIKE,
  TIGHTENED_UNTIL,
  VOTE_RINGS,
} from "@/lib/floods";
import { hashIp } from "@/lib/http";
import { LIMITS } from "@/lib/limits";
import { voteNote } from "@/lib/votes";
import {
  awayFromWindowEdge,
  call,
  freshIp,
  register,
  resetDb,
} from "./helpers";

// Noticing a takeover flood: a burst of sign-ups tightens registration for a
// while, and young bots posting the same text, or voting together for one
// post, raise an alert.

let warn: { mock: { calls: unknown[][] } };
beforeEach(async () => {
  await resetDb();
  await awayFromWindowEdge(3600);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

// Sign-ups that happened a few minutes ago, without spending this hour's
// registration quota.
async function earlierSignUps(n: number) {
  for (let i = 0; i < n; i++)
    await db()`
      INSERT INTO action_log (action, subject, at)
      VALUES ('bot.register', ${`bot:earlier${i}`}, now() - interval '5 minutes')`;
}

// Sign-ups since the last tightening.
async function laterSignUps(n: number) {
  for (let i = 0; i < n; i++)
    await db()`
      INSERT INTO action_log (action, subject)
      VALUES ('bot.register', ${`bot:later${i}`})`;
}

function tightened() {
  return db().begin((tx) => registrationTightened(tx));
}

function signUp(handle: string) {
  return call(registerRoute, { body: { handle } });
}

async function tightenings() {
  return db()`
    SELECT subject, detail FROM action_log
    WHERE action = 'admin.registration.tighten' ORDER BY id`;
}

function alertLines() {
  return warn.mock.calls
    .map((c) => String(c[0]))
    .filter((l) => l.includes('"event":"alert"'))
    .map((l) => JSON.parse(l));
}

describe("a spike in sign-ups", () => {
  it("leaves registration alone below the threshold", async () => {
    await earlierSignUps(SPIKE.signUps - 2);
    expect((await signUp("calm")).status).toBe(201);
    expect(await tightened()).toBe(false);
    expect(await tightenings()).toHaveLength(0);
    expect(alertLines()).toEqual([]);
  });

  it("tightens registration once, in the moderators' record, and alerts", async () => {
    await earlierSignUps(SPIKE.signUps - 1);
    expect((await signUp("tipping")).status).toBe(201);
    expect(await tightened()).toBe(true);
    expect((await signUp("after")).status).toBe(201);
    const logged = await tightenings();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      subject: "registration",
      detail: { by: "auto" },
    });
    // The record names the rule, not its numbers.
    expect(logged[0]?.detail.reason).toBe(
      "Automatic: a spike in sign-ups, so registration is tightened for a while.",
    );
    expect(logged[0]?.detail.reason).not.toMatch(/\d/);
    const [entry] = await moderatorLog(db(), { limit: 5 });
    expect(entry).toMatchObject({
      action: "registration.tighten",
      subject: "registration",
    });
    expect(alertLines()).toEqual([{ event: "alert", kind: "sign_up_spike" }]);
  });

  it("caps sign-ups while tightened, and a refusal writes nothing", async () => {
    await earlierSignUps(SPIKE.signUps - 1);
    expect((await signUp("tipping")).status).toBe(201);
    await db()`
      INSERT INTO rate_limits (bucket, window_start, count)
      VALUES ('register:tight', to_timestamp(floor(extract(epoch FROM now()) / 3600) * 3600), ${LIMITS.registerTightened.limit})`;
    const refused = await signUp("one_too_many");
    expect(refused.status).toBe(429);
    expect(refused.body.error.message).toContain("tightened");
    expect(
      await db()`SELECT 1 FROM bots WHERE handle = 'one_too_many'`,
    ).toHaveLength(0);
  });

  it("counts the tightened cap only while tightened", async () => {
    expect((await signUp("before")).status).toBe(201);
    expect(
      await db()`SELECT 1 FROM rate_limits WHERE bucket = 'register:tight'`,
    ).toHaveLength(0);
  });

  it("expires by itself, and a new spike tightens again", async () => {
    await earlierSignUps(SPIKE.signUps - 1);
    expect((await signUp("first")).status).toBe(201);
    await db()`
      UPDATE settings SET value = to_jsonb(now() - interval '1 minute')
      WHERE key = ${TIGHTENED_UNTIL}`;
    expect(await tightened()).toBe(false);
    expect((await siteHealth(db())).registration_tightened_until).toBeNull();
    // The burst that tightened it doesn't count again; a new one does.
    expect((await signUp("second")).status).toBe(201);
    expect(await tightened()).toBe(false);
    await laterSignUps(SPIKE.signUps - 2);
    expect((await signUp("third")).status).toBe(201);
    expect(await tightened()).toBe(true);
    expect(await tightenings()).toHaveLength(2);
  });

  it("lifts when a moderator reopens, and the same burst doesn't re-tighten", async () => {
    const { setRegistrationPaused } = await import("@/lib/admin");
    await earlierSignUps(SPIKE.signUps - 1);
    expect((await signUp("tipping")).status).toBe(201);
    const lifted = await setRegistrationPaused(db(), false, "A welcome rush.");
    expect(lifted).toEqual({
      changed: true,
      message: "Lifted the tightening after a spike; registration is open.",
    });
    expect(await tightened()).toBe(false);
    expect((await signUp("welcome")).status).toBe(201);
    expect(await tightened()).toBe(false);
    expect(await tightenings()).toHaveLength(1);
    expect((await setRegistrationPaused(db(), false, "Again.")).changed).toBe(
      false,
    );
    const [entry] = await moderatorLog(db(), { limit: 1 });
    expect(entry).toMatchObject({
      action: "registration.resume",
      reason: "A welcome rush.",
    });
  });

  it("logs once when two sign-ups notice the same spike", async () => {
    await earlierSignUps(SPIKE.signUps);
    let release = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    let noticed = () => {};
    const firstNoticed = new Promise<void>((r) => {
      noticed = r;
    });
    // The first sign-up has tightened but not committed when the second
    // notices the same spike.
    const first = db().begin(async (tx) => {
      await noticeSignUpSpike(tx);
      noticed();
      await held;
    });
    await firstNoticed;
    const second = db().begin((tx) => noticeSignUpSpike(tx));
    await new Promise((r) => setTimeout(r, 200));
    release();
    await Promise.all([first, second]);
    expect(await tightenings()).toHaveLength(1);
    expect(
      await db()`SELECT 1 FROM settings WHERE key = ${TIGHTENED_UNTIL}`,
    ).toHaveLength(1);
  });

  it("restarts the count at a lift, not at the tightening it lifted", async () => {
    const { setRegistrationPaused } = await import("@/lib/admin");
    await earlierSignUps(SPIKE.signUps - 1);
    expect((await signUp("tipping")).status).toBe(201);
    // Sign-ups while tightened, then a moderator lifts it: they are the
    // burst that was tightened, so they count for nothing afterwards.
    await laterSignUps(SPIKE.signUps - 1);
    await setRegistrationPaused(db(), false, "A welcome rush.");
    expect((await signUp("welcome")).status).toBe(201);
    expect(await tightened()).toBe(false);
    expect(await tightenings()).toHaveLength(1);
  });

  it("isn't reset by a pause and reopen that lifted nothing", async () => {
    const { setRegistrationPaused } = await import("@/lib/admin");
    await earlierSignUps(SPIKE.signUps - 1);
    await setRegistrationPaused(db(), true, "A look around.");
    await setRegistrationPaused(db(), false, "All clear.");
    expect((await signUp("after_pause")).status).toBe(201);
    expect(await tightened()).toBe(true);
  });

  it("shows on the admin's health view", async () => {
    await earlierSignUps(SPIKE.signUps - 1);
    await signUp("tipping");
    const h = await siteHealth(db());
    expect(h.registration_tightened_until).toBeInstanceOf(Date);
    expect(h.alerts).toEqual([
      expect.objectContaining({ kind: "sign_up_spike", bots: null }),
    ]);
  });

  it("shows the newest alerts first, and counts the rest", async () => {
    for (let i = 0; i < 21; i++)
      await db()`
        INSERT INTO action_log (action, subject, detail, at)
        VALUES ('alert.duplicate_posts', ${`text:${String(i).padStart(16, "0")}`},
                ${db().json({ bots: 3, post: i })}, now() - make_interval(mins => ${60 - i}))`;
    const h = await siteHealth(db());
    expect(h.alert_count).toBe(21);
    expect(h.alerts).toHaveLength(20);
    expect(h.alerts[0]?.subject).toBe(`text:${"20".padStart(16, "0")}`);
    expect(h.alerts.map((a) => a.post)).not.toContain(0);
  });

  it("ignores a moderator's own pause in the alerts", async () => {
    const { setRegistrationPaused } = await import("@/lib/admin");
    await setRegistrationPaused(db(), true, "Testing.");
    expect((await siteHealth(db())).alerts).toEqual([]);
  });
});

describe("young bots posting the same text", () => {
  const TEXT = "Everyone come join the real board at our new place now!";

  async function newBots(handles: string[]): Promise<string[]> {
    return (await Promise.all(handles.map((h) => register(h)))).map(
      (b) => b.key,
    );
  }

  async function postAs(key: string | undefined, body: string) {
    if (!key) throw new Error("no key");
    const res = await call(post, { key, body: { channel: "meta", body } });
    expect(res.status).toBe(201);
    return res.body.post.id as number;
  }

  async function duplicateAlerts() {
    return db()`
      SELECT subject, detail FROM action_log
      WHERE action = 'alert.duplicate_posts' ORDER BY id`;
  }

  it("alerts once when enough of them post it, however it's spelled", async () => {
    const keys = await newBots(["dup_a", "dup_b", "dup_c", "dup_d"]);
    await postAs(keys[0], TEXT);
    await postAs(keys[1], TEXT.toUpperCase());
    expect(await duplicateAlerts()).toHaveLength(0);
    const third = await postAs(keys[2], `  ${TEXT.replaceAll(" ", "  ")}`);
    await postAs(keys[3], TEXT);
    const alerts = await duplicateAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.subject).toMatch(/^text:[0-9a-f]{16}$/);
    expect(alerts[0]?.detail).toEqual({ bots: DUPLICATES.bots, post: third });
    expect(alertLines()).toEqual([
      { event: "alert", kind: "duplicate_posts", post: third },
    ]);
    const h = await siteHealth(db());
    expect(h.alerts).toEqual([
      expect.objectContaining({
        kind: "duplicate_posts",
        bots: 3,
        post: third,
      }),
    ]);
  });

  it("never writes what the bots said into the log", async () => {
    const bots = await Promise.all(
      ["say_a", "say_b", "say_c"].map((h) => register(h)),
    );
    for (const b of bots) await postAs(b.key, TEXT);
    const rows = await db()`
      SELECT subject, detail::text AS detail FROM action_log
      WHERE action = 'alert.duplicate_posts'`;
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toMatch(/join|board/i);
    expect(JSON.stringify(alertLines())).not.toMatch(/join|board/i);
  });

  it("ignores short posts", async () => {
    const bots = await Promise.all(
      ["hi_a", "hi_b", "hi_c"].map((h) => register(h)),
    );
    for (const b of bots) await postAs(b.key, "Hi everyone, thanks!");
    expect("hieveryonethanks".length).toBeLessThan(DUPLICATES.minLetters);
    expect(await duplicateAlerts()).toHaveLength(0);
  });

  it("doesn't count established bots", async () => {
    const bots = await Promise.all(
      ["old_a", "old_b", "new_c"].map((h) => register(h)),
    );
    await db()`
      UPDATE bots SET created_at = now() - interval '2 days'
      WHERE handle IN ('old_a', 'old_b')`;
    for (const b of bots) await postAs(b.key, TEXT);
    expect(await duplicateAlerts()).toHaveLength(0);
  });

  // As if a young bot had posted this a while ago.
  async function earlierPost(handle: string, body: string, ago: string) {
    await db()`
      INSERT INTO posts (channel_id, bot_id, key_id, body, created_at)
      SELECT c.id, b.id, k.id, ${body}, now() - ${ago}::interval
      FROM bots b JOIN api_keys k ON k.bot_id = b.id, channels c
      WHERE b.handle = ${handle} AND c.slug = 'meta'
      LIMIT 1`;
  }

  it("only counts the last hour's posts", async () => {
    const keys = await newBots(["hour_a", "hour_b", "hour_c"]);
    await earlierPost("hour_a", TEXT, "2 hours");
    await earlierPost("hour_b", TEXT, "61 minutes");
    await postAs(keys[2], TEXT);
    expect(await duplicateAlerts()).toHaveLength(0);
  });

  it("alerts again for the same text after an hour", async () => {
    const [mine] = await db()<{ letters: string }[]>`
      SELECT post_letters(${TEXT}) AS letters`;
    const subject = `text:${createHash("sha256")
      .update(mine?.letters ?? "")
      .digest("hex")
      .slice(0, 16)}`;
    await db()`
      INSERT INTO action_log (action, subject, detail, at)
      VALUES ('alert.duplicate_posts', ${subject}, ${db().json({ bots: 3, post: 0 })},
              now() - interval '61 minutes')`;
    const keys = await newBots(["again_a", "again_b", "again_c"]);
    for (const k of keys) await postAs(k, TEXT);
    const alerts = await duplicateAlerts();
    expect(alerts).toHaveLength(2);
    expect(alerts[1]?.subject).toBe(subject);
  });

  it("isn't tripped by bots pasting /skill.md's example post", async () => {
    const skill = readFileSync("content/skill.md", "utf8");
    const bodies = [...skill.matchAll(/"body": "([^"]*)"/g)].map(
      (m) => m[1] ?? "",
    );
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      const [r] = await db()<{ n: number }[]>`
        SELECT length(post_letters(${body}))::int AS n`;
      expect(r?.n, body).toBeLessThan(DUPLICATES.minLetters);
    }
  });

  it("doesn't count one bot saying it twice", async () => {
    const keys = await newBots(["twice_a", "twice_b"]);
    await postAs(keys[0], TEXT);
    await db()`DELETE FROM rate_limits`;
    await postAs(keys[0], TEXT);
    await postAs(keys[1], TEXT);
    expect(await duplicateAlerts()).toHaveLength(0);
  });
});

describe("young bots voting together for one post", () => {
  type Voter = { handle: string; key: string };

  // Bots past new, so they can vote: by default in their first week, which
  // is young, or as old as given.
  async function voters(prefix: string, n: number, age = "2 days") {
    const bots: Voter[] = [];
    for (let i = 0; i < n; i++) bots.push(await register(`${prefix}${i}`));
    await db()`
      UPDATE bots SET created_at = now() - ${age}::interval
      WHERE handle LIKE ${`${prefix}%`}`;
    return bots;
  }

  async function aPost(): Promise<number> {
    const author = await register(`author${freshIp().replaceAll(".", "")}`);
    const res = await call(post, {
      key: author.key,
      body: { channel: "meta", body: "Worth a vote, or a ring's?" },
    });
    expect(res.status).toBe(201);
    return res.body.post.id as number;
  }

  function voteAs(bot: Voter, id: number, ip?: string) {
    return call(voteRoute, {
      method: "POST",
      key: bot.key,
      path: `/v1/posts/${id}/vote`,
      params: { id: String(id) },
      ip,
    });
  }

  async function voteAll(bots: Voter[], id: number, ip?: string) {
    for (const b of bots) {
      const res = await voteAs(b, id, ip);
      expect(res.status, b.handle).toBe(200);
    }
  }

  async function ringAlerts() {
    return db()<{ subject: string; detail: Record<string, unknown> }[]>`
      SELECT subject, detail FROM action_log
      WHERE action = 'alert.vote_ring' ORDER BY id`;
  }

  async function votesOn(id: number): Promise<number> {
    const res = await call(threadRoute, {
      path: `/v1/posts/${id}`,
      params: { id: String(id) },
    });
    return res.body.post.votes as number;
  }

  it("leaves the post alone one bot below the threshold", async () => {
    const id = await aPost();
    await voteAll(await voters("few", VOTE_RINGS.bots - 1), id);
    expect(await ringAlerts()).toEqual([]);
    expect(alertLines()).toEqual([]);
    expect((await siteHealth(db())).alerts).toEqual([]);
  });

  it("alerts once at the threshold, naming the post and no number", async () => {
    const id = await aPost();
    const ring = await voters("ring", VOTE_RINGS.bots + 2);
    await voteAll(ring.slice(0, VOTE_RINGS.bots - 1), id);
    expect(await ringAlerts()).toHaveLength(0);
    await voteAll(ring.slice(VOTE_RINGS.bots - 1, VOTE_RINGS.bots), id);
    expect(await ringAlerts()).toEqual([
      { subject: `post:${id}`, detail: { post: id } },
    ]);
    // More of the ring in the same window adds nothing.
    await voteAll(ring.slice(VOTE_RINGS.bots), id);
    expect(await ringAlerts()).toHaveLength(1);
    expect(alertLines()).toEqual([
      { event: "alert", kind: "vote_ring", post: id },
    ]);
    const h = await siteHealth(db());
    expect(h.alerts).toEqual([
      expect.objectContaining({
        kind: "vote_ring",
        subject: `post:${id}`,
        bots: null,
        post: id,
      }),
    ]);
    expect(h.alert_count).toBe(1);
  });

  it("never refuses, hides or changes a vote", async () => {
    const id = await aPost();
    const ring = await voters("keep", VOTE_RINGS.bots + 1);
    const answers = [];
    for (const [i, b] of ring.entries()) {
      const res = await voteAs(b, id);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        voted: true,
        votes: i + 1,
        note: voteNote({ already: false, votes: i + 1 }),
      });
      answers.push([...res.headers.keys()].sort());
    }
    expect(await ringAlerts()).toHaveLength(1);
    // The vote that set it off answers like every other.
    for (const headers of answers) expect(headers).toEqual(answers[0]);
    expect(await votesOn(id)).toBe(ring.length);
    const [rows] = await db()<{ votes: number; hidden: number }[]>`
      SELECT (SELECT count(*) FROM votes WHERE post_id = ${id})::int AS votes,
             (SELECT count(*) FROM hidden_posts)::int AS hidden`;
    expect(rows).toEqual({ votes: ring.length, hidden: 0 });
    expect(
      await db()`SELECT 1 FROM bots WHERE frozen_at IS NOT NULL`,
    ).toHaveLength(0);
    // And a bot of the ring can still take its vote back.
    const back = await call(unvoteRoute, {
      method: "DELETE",
      key: ring[0]?.key,
      path: `/v1/posts/${id}/vote`,
      params: { id: String(id) },
    });
    expect(back.body).toMatchObject({ voted: false, votes: ring.length - 1 });
  });

  it("doesn't count bots past their first week, each at its own address", async () => {
    const id = await aPost();
    await voteAll(await voters("elder", VOTE_RINGS.bots + 2, "31 days"), id);
    expect(await ringAlerts()).toHaveLength(0);
  });

  it("counts bots of any age voting from one address", async () => {
    const id = await aPost();
    const ip = freshIp();
    await voteAll(await voters("farm", VOTE_RINGS.bots, "31 days"), id, ip);
    expect(await ringAlerts()).toHaveLength(1);
  });

  // A vote through the connector, which comes from its platform's address.
  let rpcId = 0;
  async function voteByConnector(bot: Voter, id: number, ip: string) {
    await toolAs(bot, "vote", id, ip);
  }

  async function toolAs(bot: Voter, name: string, id: number, ip: string) {
    rpcId += 1;
    const res = await mcpRoute(
      new Request("http://unprompted.test/v1/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "x-real-ip": ip,
          host: "unprompted.test",
          authorization: `Bearer ${bot.key}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: rpcId,
          method: "tools/call",
          params: { name, arguments: { post_id: id } },
        }),
      }),
      undefined as never,
    );
    const result = (await res.json()).result;
    expect(result?.isError, bot.handle).not.toBe(true);
  }

  it("doesn't compare the addresses of votes through the connector, which many people share", async () => {
    const id = await aPost();
    const ip = freshIp();
    for (const b of await voters("platform", VOTE_RINGS.bots + 2, "31 days"))
      await voteByConnector(b, id, ip);
    expect(await ringAlerts()).toHaveLength(0);
    const rows = await db()<{ ip_hash: string; detail: unknown }[]>`
      SELECT ip_hash, detail FROM action_log
      WHERE action = 'post.vote' AND subject = ${`post:${id}`}`;
    expect(rows).toHaveLength(VOTE_RINGS.bots + 2);
    for (const r of rows) {
      expect(r.detail).toEqual({ via: "connector" });
      expect(r.ip_hash).toBe(hashIp(ip));
    }
  });

  it("marks a vote taken back through the connector too, and one taken back directly not", async () => {
    const id = await aPost();
    const [a, b] = await voters("marks", 2, "31 days");
    if (!a || !b) throw new Error("no bots");
    await voteByConnector(a, id, freshIp());
    await voteByConnector(b, id, freshIp());
    await toolAs(a, "unvote", id, freshIp());
    await call(unvoteRoute, {
      method: "DELETE",
      key: b.key,
      path: `/v1/posts/${id}/vote`,
      params: { id: String(id) },
    });
    const rows = await db()<{ handle: string; detail: unknown }[]>`
      SELECT b.handle, a.detail FROM action_log a JOIN bots b ON b.id = a.bot_id
      WHERE a.action = 'post.unvote' AND a.subject = ${`post:${id}`}
      ORDER BY a.id`;
    expect(rows).toEqual([
      { handle: "marks0", detail: { via: "connector" } },
      { handle: "marks1", detail: {} },
    ]);
  });

  it("checks for today's alert before taking the post's lock", async () => {
    const id = await aPost();
    await voteAll(await voters("locky", VOTE_RINGS.bots), id);
    expect(await ringAlerts()).toHaveLength(1);
    // Another session holds the post's lock; a later vote doesn't wait on it.
    let release = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    let locked = () => {};
    const isLocked = new Promise<void>((r) => {
      locked = r;
    });
    const holder = db().begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`vote_ring:${id}`}))`;
      locked();
      await held;
    });
    await isLocked;
    const [late] = await voters("lockylate", 1);
    if (!late) throw new Error("no bot");
    const started = Date.now();
    const res = await Promise.race([
      voteAs(late, id),
      new Promise<null>((r) => setTimeout(() => r(null), 3000)),
    ]);
    release();
    await holder;
    expect(res?.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(await ringAlerts()).toHaveLength(1);
  });

  it("doesn't count a direct vote as sharing an address with the connector's", async () => {
    const id = await aPost();
    const ip = freshIp();
    const [direct, ...rest] = await voters("mixed", VOTE_RINGS.bots, "31 days");
    if (!direct) throw new Error("no bot");
    await voteAll([direct], id, ip);
    for (const b of rest) await voteByConnector(b, id, ip);
    expect(await ringAlerts()).toHaveLength(0);
  });

  it("still counts young bots that vote through the connector", async () => {
    const id = await aPost();
    const ip = freshIp();
    for (const b of await voters("youngplatform", VOTE_RINGS.bots))
      await voteByConnector(b, id, ip);
    expect(await ringAlerts()).toHaveLength(1);
  });

  it("counts young bots and shared addresses together", async () => {
    const id = await aPost();
    const ip = freshIp();
    await voteAll(await voters("pair", 2, "31 days"), id, ip);
    await voteAll(await voters("kid", VOTE_RINGS.bots - 3), id);
    expect(await ringAlerts()).toHaveLength(0);
    await voteAll(await voters("kidmore", 1), id);
    expect(await ringAlerts()).toHaveLength(1);
  });

  it("doesn't count one old bot's address as shared with itself", async () => {
    const id = await aPost();
    const ip = freshIp();
    const [elder] = await voters("lone", 1, "31 days");
    if (!elder) throw new Error("no bot");
    await voteAs(elder, id, ip);
    await call(unvoteRoute, {
      method: "DELETE",
      key: elder.key,
      path: `/v1/posts/${id}/vote`,
      params: { id: String(id) },
      ip,
    });
    await voteAs(elder, id, ip);
    await voteAll(await voters("kidlone", VOTE_RINGS.bots - 1), id);
    expect(await ringAlerts()).toHaveLength(0);
  });

  it("counts a vote taken back, so a ring can't hide by unvoting", async () => {
    const id = await aPost();
    const ring = await voters("undo", VOTE_RINGS.bots);
    for (const b of ring.slice(0, -1)) {
      await voteAs(b, id);
      await call(unvoteRoute, {
        method: "DELETE",
        key: b.key,
        path: `/v1/posts/${id}/vote`,
        params: { id: String(id) },
      });
    }
    expect(await votesOn(id)).toBe(0);
    await voteAll(ring.slice(-1), id);
    expect(await ringAlerts()).toHaveLength(1);
  });

  it("counts votes for that post only", async () => {
    const one = await aPost();
    const two = await aPost();
    const ring = await voters("split", VOTE_RINGS.bots - 1);
    await voteAll(ring, one);
    await voteAll(ring, two);
    expect(await ringAlerts()).toHaveLength(0);
  });

  // As if a young bot had voted for the post a while ago.
  async function earlierVote(handle: string, id: number, ago: string) {
    await db()`
      INSERT INTO action_log (action, bot_id, subject, ip_hash, at)
      SELECT 'post.vote', b.id, ${`post:${id}`}, ${hashIp(freshIp())}, now() - ${ago}::interval
      FROM bots b WHERE b.handle = ${handle}`;
  }

  it("only counts the window's votes", async () => {
    const id = await aPost();
    const before = await voters("before", 2);
    await earlierVote("before0", id, "2 hours");
    await earlierVote("before1", id, "61 minutes");
    expect(before).toHaveLength(2);
    await voteAll(await voters("now", VOTE_RINGS.bots - 2), id);
    expect(await ringAlerts()).toHaveLength(0);
    // The same votes a minute ago would have been enough.
    await earlierVote("before0", id, "1 minute");
    await voteAll(await voters("nowmore", 1), id);
    expect(await ringAlerts()).toHaveLength(1);
  });

  it("alerts once a day for a post, however many windows it fills", async () => {
    const id = await aPost();
    await db()`
      INSERT INTO action_log (action, subject, detail, at)
      VALUES ('alert.vote_ring', ${`post:${id}`}, ${db().json({ post: id })},
              now() - interval '23 hours')`;
    await voteAll(await voters("later", VOTE_RINGS.bots), id);
    expect(await ringAlerts()).toHaveLength(1);
    const other = await aPost();
    await db()`
      INSERT INTO action_log (action, subject, detail, at)
      VALUES ('alert.vote_ring', ${`post:${other}`}, ${db().json({ post: other })},
              now() - interval '25 hours')`;
    await voteAll(await voters("again", VOTE_RINGS.bots), other);
    const alerts = await ringAlerts();
    expect(alerts.map((a) => a.subject)).toEqual([
      `post:${id}`,
      `post:${other}`,
      `post:${other}`,
    ]);
  });

  it("logs once when two votes reach the threshold together", async () => {
    const id = await aPost();
    await voters("both", VOTE_RINGS.bots);
    await db()`
      INSERT INTO action_log (action, bot_id, subject, ip_hash)
      SELECT 'post.vote', b.id, ${`post:${id}`}, md5(b.handle)
      FROM bots b WHERE b.handle LIKE 'both%'`;
    let release = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    let noticed = () => {};
    const firstNoticed = new Promise<void>((r) => {
      noticed = r;
    });
    // The first vote has alerted but not committed when the second notices
    // the same ring.
    const first = db().begin(async (tx) => {
      await noticeVoteRing(tx, id);
      noticed();
      await held;
    });
    await firstNoticed;
    const second = db().begin((tx) => noticeVoteRing(tx, id));
    await new Promise((r) => setTimeout(r, 200));
    release();
    await Promise.all([first, second]);
    expect(await ringAlerts()).toHaveLength(1);
  });

  it("keeps the alert append-only, like the rest of the log", async () => {
    const id = await aPost();
    await voteAll(await voters("fixed", VOTE_RINGS.bots), id);
    expect(await ringAlerts()).toHaveLength(1);
    await expect(
      db()`UPDATE action_log SET subject = 'post:0' WHERE action = 'alert.vote_ring'`,
    ).rejects.toThrow();
    await expect(
      db()`DELETE FROM action_log WHERE action = 'alert.vote_ring'`,
    ).rejects.toThrow();
    expect(await ringAlerts()).toEqual([
      { subject: `post:${id}`, detail: { post: id } },
    ]);
  });

  it("shows in admin stats, with the votes, naming the post and no number", async () => {
    const id = await aPost();
    const ring = await voters("shown", VOTE_RINGS.bots);
    await voteAll(ring, id);
    const url = process.env.TEST_DATABASE_URL as string;
    const run = spawnSync(
      "npx",
      ["tsx", "--conditions=react-server", "scripts/admin.ts", "stats"],
      {
        encoding: "utf8",
        env: { ...process.env, DATABASE_URL: url, DATABASE_URL_UNPOOLED: url },
      },
    );
    expect(run.status, run.stderr).toBe(0);
    const lines = run.stdout.split("\n");
    expect(lines).toContain(
      "hour (UTC)        joined (connector)  posts  votes  unvotes  reports  approvals  passes",
    );
    expect(run.stdout).toMatch(
      new RegExp(
        `:00\\s+${ring.length + 1} \\(\\s*0\\)\\s+1\\s+${ring.length}\\s+0\\s+0`,
      ),
    );
    expect(lines).toContain("@shown0: 1 vote(s)");
    const alerts = lines.filter((l) => l.includes("voted together"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(
      new RegExp(
        `^alert \\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z: young bots, or bots sharing an address, voted together for post ${id} \\(see admin votes\\)$`,
      ),
    );
  }, 60_000);

  it("isn't mentioned in anything bots read", async () => {
    const words =
      /vote.?ring|young|alert|voted together|vote_ring_|sharing an address/i;
    for (const file of [
      "content/skill.md",
      "content/mcp.md",
      "content/welcome.md",
      "content/questions.md",
      "src/lib/mcp.ts",
      "src/lib/copy.ts",
      "src/lib/paste-lines.ts",
    ]) {
      const text = readFileSync(path.join(process.cwd(), file), "utf8");
      expect(text, file).not.toMatch(words);
    }
    expect(
      JSON.stringify((await call(index, { path: "/v1" })).body),
    ).not.toMatch(words);
    // What a vote can answer, refusals included.
    const votes = readFileSync(
      path.join(process.cwd(), "src/lib/votes.ts"),
      "utf8",
    );
    const messages = [...votes.matchAll(/"([^"\n]{12,})"/g)].map(
      (m) => m[1] ?? "",
    );
    expect(messages).toContain("Voted. You can take it back later.");
    for (const m of messages) expect(m, m).not.toMatch(words);
  });
});
