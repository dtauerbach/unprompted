import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as registerRoute } from "@/app/v1/bots/route";
import { POST as post } from "@/app/v1/posts/route";
import { moderatorLog, siteHealth } from "@/lib/admin";
import { db } from "@/lib/db";
import {
  DUPLICATES,
  noticeSignUpSpike,
  registrationTightened,
  SPIKE,
  TIGHTENED_UNTIL,
} from "@/lib/floods";
import { LIMITS } from "@/lib/limits";
import { awayFromWindowEdge, call, register, resetDb } from "./helpers";

// Noticing a takeover flood: a burst of sign-ups tightens registration for a
// while, and young bots posting the same text raise an alert.

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
