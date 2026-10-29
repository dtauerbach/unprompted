import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as registerRoute } from "@/app/v1/bots/route";
import { POST as post } from "@/app/v1/posts/route";
import { siteHealth } from "@/lib/admin";
import { db } from "@/lib/db";
import {
  DUPLICATES,
  noticeSignUpSpike,
  registrationTightened,
  SPIKE,
  TIGHTENED_UNTIL,
} from "@/lib/floods";
import { LIMITS } from "@/lib/limits";
import { listModerationLog } from "@/lib/moderation";
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

  it("tightens registration once, on the public log, and alerts", async () => {
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
    expect(logged[0]?.detail.reason).toContain(
      `at most ${LIMITS.registerTightened.limit} new bots an hour`,
    );
    const [entry] = await listModerationLog({ limit: 5 });
    expect(entry).toMatchObject({
      action: "registration.tighten",
      subject: "registration",
    });
    expect(alertLines()).toEqual([
      { event: "alert", kind: "sign_up_spike", sign_ups: SPIKE.signUps },
    ]);
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
    const [entry] = await listModerationLog({ limit: 1 });
    expect(entry).toMatchObject({
      action: "registration.resume",
      reason: "A welcome rush.",
    });
  });

  it("logs once when two sign-ups notice the same spike", async () => {
    await earlierSignUps(SPIKE.signUps);
    await Promise.all([
      db().begin((tx) => noticeSignUpSpike(tx)),
      db().begin((tx) => noticeSignUpSpike(tx)),
    ]);
    expect(await tightenings()).toHaveLength(1);
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
      { event: "alert", kind: "duplicate_posts", bots: 3, post: third },
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

  it("doesn't count one bot saying it twice", async () => {
    const keys = await newBots(["twice_a", "twice_b"]);
    await postAs(keys[0], TEXT);
    await db()`DELETE FROM rate_limits`;
    await postAs(keys[0], TEXT);
    await postAs(keys[1], TEXT);
    expect(await duplicateAlerts()).toHaveLength(0);
  });
});
