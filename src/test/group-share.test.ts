import { beforeEach, describe, expect, it } from "vitest";
import { POST as inboxRoute } from "@/app/v1/me/inbox/route";
import { POST as sendRoute } from "@/app/v1/messages/route";
import { antiAbuseWarnings, setAntiAbuse } from "@/lib/admin";
import { db } from "@/lib/db";
import { groupMessageRules, groupWakeRules } from "@/lib/limits";
import { setOwnBots, startChannel } from "@/lib/private-channels";
import { ANTI_ABUSE_DEFAULTS } from "@/lib/settings";
import {
  awayFromWindowEdge,
  call,
  establish,
  register,
  resetDb,
} from "./helpers";

// A person's share of the site-wide caps a group message counts against:
// messages, and the wakes they raise, keyed on who started the group
// (group_channels.human_id). One person's busy groups, or two of their bots
// answering each other, use up that person's share and no more, so every
// other person's groups still get through. The shares are private numbers,
// like the caps.

beforeEach(async () => {
  await resetDb();
  await awayFromWindowEdge(3600);
});

type Bot = { handle: string; key: string };

async function settled(handle: string): Promise<Bot> {
  const b = await register(handle);
  await establish(handle);
  return b;
}

async function groupOf(authId: string, ...bots: Bot[]): Promise<string> {
  const [h] = await db()<{ id: string }[]>`
    INSERT INTO humans (auth_user_id) VALUES (${authId})
    ON CONFLICT (auth_user_id) DO UPDATE SET auth_user_id = EXCLUDED.auth_user_id
    RETURNING id`;
  for (const b of bots)
    await db()`UPDATE bots SET owner_id = ${h?.id ?? null} WHERE handle = ${b.handle}`;
  const r = await startChannel(
    db(),
    authId,
    bots.map((b) => b.handle),
    undefined,
    null,
  );
  return r.channel;
}

const say = (b: Bot, channel: string, text: string) =>
  call(sendRoute, { key: b.key, body: { channel, body: text } });

async function state(): Promise<string> {
  const w = await db()`
    SELECT bucket, window_start, count FROM rate_limits ORDER BY bucket, window_start`;
  const b = await db()`SELECT bucket, full_at FROM rate_bursts ORDER BY bucket`;
  const m = await db()`SELECT count(*)::int AS n FROM messages`;
  const l = await db()`SELECT count(*)::int AS n FROM action_log`;
  const k = await db()`SELECT bot_id, count FROM wake_counters ORDER BY bot_id`;
  return JSON.stringify({ w, b, m, l, k });
}

const SHARE =
  /the share of the site's private channel messages this hour for this channel's person/;

// biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary response JSON
function refusedForShare(res: { status: number; body: any; headers: Headers }) {
  expect(res.status).toBe(429);
  expect(res.body.error.code).toBe("rate_limited");
  expect(res.body.error.message).toMatch(SHARE);
  const retry = Number(res.headers.get("retry-after"));
  // No number but the wait.
  expect(
    res.body.error.message.replace(`Try again in ${retry} seconds.`, ""),
  ).not.toMatch(/\d/);
  return retry;
}

// Two teams: alice and bob flood one group, cat and dan talk in another.
async function teams() {
  const a = await settled("alice");
  const b = await settled("bob");
  const c = await settled("cat");
  const d = await settled("dan");
  const busy = await groupOf("google-busy", a, b);
  const quiet = await groupOf("google-quiet", c, d);
  return { a, b, c, d, busy, quiet };
}

describe("the rules", () => {
  it("put the person's share before each site-wide cap", () => {
    expect(
      groupMessageRules(7, "person:9", ANTI_ABUSE_DEFAULTS).map(
        (r) => r.bucket,
      ),
    ).toEqual([
      "group:burst:7",
      "group:day:7",
      "group-message:person:9",
      "group-message:all",
    ]);
    expect(
      groupWakeRules("person:9", ANTI_ABUSE_DEFAULTS).map((r) => r.bucket),
    ).toEqual(["channel-wake:person:9", "channel-wake:all"]);
    const share = [
      groupMessageRules(7, "person:9", ANTI_ABUSE_DEFAULTS)[2],
      groupWakeRules("person:9", ANTI_ABUSE_DEFAULTS)[0],
    ];
    expect(share.map((r) => r?.limit)).toEqual([
      ANTI_ABUSE_DEFAULTS.group_message_person,
      ANTI_ABUSE_DEFAULTS.group_wake_person,
    ]);
    // One label for both, with no number, so a refusal says neither which
    // share nor how big.
    expect(share[0]?.label).toBe(share[1]?.label);
    expect(share[0]?.label).not.toMatch(/\d/);
  });

  it("default to a share below each site-wide cap", () => {
    expect(ANTI_ABUSE_DEFAULTS.group_message_person).toBeLessThan(
      ANTI_ABUSE_DEFAULTS.group_message_global,
    );
    expect(ANTI_ABUSE_DEFAULTS.group_wake_person).toBeLessThan(
      ANTI_ABUSE_DEFAULTS.channel_wake_global,
    );
    expect(antiAbuseWarnings(ANTI_ABUSE_DEFAULTS)).toEqual([]);
  });

  it("warn a moderator whose share would let one person take a whole cap, naming no number", () => {
    const warnings = antiAbuseWarnings({
      ...ANTI_ABUSE_DEFAULTS,
      group_message_person: ANTI_ABUSE_DEFAULTS.group_message_global,
      group_wake_person: ANTI_ABUSE_DEFAULTS.channel_wake_global + 1,
    });
    expect(warnings).toEqual([
      expect.stringMatching(
        /^group_message_person is at or above group_message_global/,
      ),
      expect.stringMatching(
        /^group_wake_person is at or above channel_wake_global/,
      ),
    ]);
    for (const w of warnings) expect(w).not.toMatch(/\d/);
  });
});

describe("two bots of one person flooding a group", () => {
  it("use up their person's share of messages, and another person's group still gets through", async () => {
    const { a, b, c, d, busy, quiet } = await teams();
    await setAntiAbuse(db(), { group_message_person: 5 }, "test");
    let passed = 0;
    let refused: Awaited<ReturnType<typeof say>> | undefined;
    for (let i = 0; i < 12 && !refused; i++) {
      const res = await say(i % 2 ? b : a, busy, `flood ${i}`);
      if (res.status === 201) passed += 1;
      else refused = res;
    }
    expect(passed).toBe(5);
    if (!refused) throw new Error("never refused");
    const retry = refusedForShare(refused);
    // To the hour's end, by the database's clock.
    const [w] = await db()<{ left: number }[]>`
      SELECT ceil(3600 - (extract(epoch FROM now()) - floor(extract(epoch FROM now()) / 3600) * 3600))::int AS left`;
    expect(Math.abs(retry - (w?.left ?? 0))).toBeLessThanOrEqual(1);
    // Both flooders are held, each well inside its own burst.
    refusedForShare(await say(a, busy, "more"));
    refusedForShare(await say(b, busy, "more"));
    // The other group isn't.
    for (let i = 0; i < 5; i++)
      expect((await say(i % 2 ? d : c, quiet, `quiet ${i}`)).status).toBe(201);
  });

  it("use up their person's share of wakes, and another person's group still gets through", async () => {
    const a = await settled("alice");
    const b = await settled("bob");
    const e = await settled("eve");
    const f = await settled("fay");
    const c = await settled("cat");
    const d = await settled("dan");
    // A message in busy wakes the other three.
    const busy = await groupOf("google-busy", a, b, e, f);
    const quiet = await groupOf("google-quiet", c, d);
    // Starting it woke its four, leaving nine.
    await setAntiAbuse(db(), { group_wake_person: 13 }, "test");
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++)
      statuses.push((await say(i % 2 ? b : a, busy, `flood ${i}`)).status);
    // Three messages wake nine (thirteen in all); a fourth would make sixteen.
    expect(statuses).toEqual([201, 201, 201, 429, 429]);
    refusedForShare(await say(b, busy, "more"));
    expect((await say(c, quiet, "still here")).status).toBe(201);
    expect((await say(d, quiet, "and here")).status).toBe(201);
  });

  it("refuse without writing anything or using any quota", async () => {
    const { a, b, busy } = await teams();
    await setAntiAbuse(db(), { group_message_person: 2 }, "test");
    expect((await say(a, busy, "one")).status).toBe(201);
    expect((await say(b, busy, "two")).status).toBe(201);
    const before = await state();
    for (let i = 0; i < 3; i++)
      refusedForShare(await say(i % 2 ? b : a, busy, "refused"));
    expect(await state()).toBe(before);
  });

  it("leave the site-wide cap in force: a share keeps room, it doesn't add any", async () => {
    const { a, b, c, d, busy, quiet } = await teams();
    await setAntiAbuse(
      db(),
      { group_message_person: 5, group_message_global: 7 },
      "test",
    );
    for (let i = 0; i < 5; i++)
      expect((await say(i % 2 ? b : a, busy, `flood ${i}`)).status).toBe(201);
    refusedForShare(await say(a, busy, "over its share"));
    // The quiet group has the two left in the hour, then the site's cap.
    expect((await say(c, quiet, "one")).status).toBe(201);
    expect((await say(d, quiet, "two")).status).toBe(201);
    const capped = await say(c, quiet, "three");
    expect(capped.status).toBe(429);
    expect(capped.body.error.message).toMatch(/whole site this hour/);
  });

  it("can't be spent by a bot outside the group, or tell it apart from a made-up one", async () => {
    const { a, b, busy } = await teams();
    const x = await settled("xena");
    const y = await settled("yuri");
    const own = await groupOf("google-x", x, y);
    await setAntiAbuse(db(), { group_message_person: 2 }, "test");
    // The busy person's share is used up, and so is xena's own group burst.
    expect((await say(a, busy, "one")).status).toBe(201);
    expect((await say(b, busy, "two")).status).toBe(201);
    refusedForShare(await say(a, busy, "three"));
    const [xb] = await db()<{ id: string }[]>`
      SELECT id FROM bots WHERE handle = 'xena'`;
    await db()`
      INSERT INTO rate_bursts (bucket, full_at)
      VALUES (${`group:burst:${xb?.id}`}, now() + interval '1 hour')`;
    const held = await say(x, own, "in my own group");
    expect(held.status).toBe(429);
    expect(held.body.error.message).toMatch(/group messages in a row/);
    const before = await state();
    // A real group and a made-up one answer alike: no share, no burst, no
    // hint that the first exists or is full.
    const real = await say(x, busy, "let me in");
    const madeUp = await say(x, "private:999999999", "let me in");
    expect(real.status).toBe(404);
    expect(real.body.error.code).toBe("no_such_channel");
    expect(madeUp.status).toBe(real.status);
    expect(madeUp.body).toEqual(real.body);
    expect(real.headers.get("retry-after")).toBeNull();
    expect(await state()).toBe(before);
  });

  it("counts all of one person's groups together, and no one else's", async () => {
    const { a, b, c, d, busy, quiet } = await teams();
    const g = await settled("gus");
    // alice is in a second group with gus, started by the same person.
    const [h] = await db()<{ id: string }[]>`
      SELECT id FROM humans WHERE auth_user_id = 'google-busy'`;
    await db()`UPDATE bots SET owner_id = ${h?.id ?? null} WHERE handle = 'gus'`;
    const other = (
      await startChannel(db(), "google-busy", ["alice", "gus"], undefined, null)
    ).channel;
    await setAntiAbuse(db(), { group_message_person: 3 }, "test");
    for (let i = 0; i < 3; i++)
      expect((await say(i % 2 ? b : a, busy, `busy ${i}`)).status).toBe(201);
    refusedForShare(await say(a, busy, "over"));
    // The same person's other group shares the share, whoever writes.
    refusedForShare(await say(a, other, "elsewhere"));
    refusedForShare(await say(g, other, "hi"));
    // Another person's group has its own.
    for (let i = 0; i < 3; i++)
      expect((await say(i % 2 ? d : c, quiet, `quiet ${i}`)).status).toBe(201);
  });

  it("holds groups only: the person's bots still write one to one", async () => {
    const { a, b, busy } = await teams();
    const x = await settled("xena");
    // Both open, since a bot writing first must take an answer.
    for (const k of [a, x])
      await call(inboxRoute, { key: k.key, body: { open: true } });
    await setAntiAbuse(db(), { group_message_person: 2 }, "test");
    expect((await say(a, busy, "one")).status).toBe(201);
    expect((await say(b, busy, "two")).status).toBe(201);
    refusedForShare(await say(a, busy, "three"));
    const toX = await call(sendRoute, {
      key: a.key,
      body: { to: "xena", body: "one to one" },
    });
    expect(toX.status).toBe(201);
  });

  it("leaves pairs alone when groups fill their own site-wide cap", async () => {
    const { a, b, c, d, busy, quiet } = await teams();
    const x = await settled("xena");
    const y = await settled("yuri");
    for (const k of [x, y])
      await call(inboxRoute, { key: k.key, body: { open: true } });
    await setAntiAbuse(db(), { group_message_global: 4 }, "test");
    for (let i = 0; i < 4; i++)
      expect((await say(i % 2 ? b : a, busy, `flood ${i}`)).status).toBe(201);
    const capped = await say(c, quiet, "too late");
    expect(capped.status).toBe(429);
    expect(capped.body.error.message).toMatch(
      /private channel messages across the whole site this hour/,
    );
    expect((await say(d, quiet, "and me")).status).toBe(429);
    const pair = await call(sendRoute, {
      key: x.key,
      body: { to: "yuri", body: "pairs are apart" },
    });
    expect(pair.status).toBe(201);
  });
});

describe("a person's own changes", () => {
  it("count the wakes of starting a group and putting bots in against the person's share", async () => {
    const a = await settled("alice");
    const b = await settled("bob");
    await settled("eve");
    await settled("fay");
    await setAntiAbuse(db(), { group_wake_person: 4 }, "test");
    // Starting it wakes its two bots, then a message wakes one more.
    const busy = await groupOf("google-busy", a, b);
    expect((await say(a, busy, "hello")).status).toBe(201);
    // Putting two more in would make five.
    const [h] = await db()<{ id: string }[]>`
      SELECT id FROM humans WHERE auth_user_id = 'google-busy'`;
    await db()`UPDATE bots SET owner_id = ${h?.id ?? null} WHERE handle IN ('eve', 'fay')`;
    const before = await state();
    const err = await setOwnBots(
      db(),
      "google-busy",
      busy,
      ["eve", "fay"],
      [],
      null,
    ).catch((x: unknown) => x);
    expect(err).toMatchObject({ status: 429, code: "rate_limited" });
    const message = (err as Error).message;
    expect(message).toMatch(SHARE);
    expect(message.replace(/Try again in \d+ seconds\./, "")).not.toMatch(/\d/);
    expect(await state()).toBe(before);
    // So is starting another group of three, which would make six.
    await expect(
      startChannel(
        db(),
        "google-busy",
        ["alice", "eve", "fay"],
        undefined,
        null,
      ),
    ).rejects.toMatchObject({ status: 429, code: "rate_limited" });
    expect(await state()).toBe(before);
    // One more fits, and spends the last of it, messages included.
    await setOwnBots(db(), "google-busy", busy, ["eve"], [], null);
    refusedForShare(await say(b, busy, "one too many"));
  });

  it("leave another person's share alone", async () => {
    const a = await settled("alice");
    const b = await settled("bob");
    const c = await settled("cat");
    const d = await settled("dan");
    await setAntiAbuse(db(), { group_wake_person: 3 }, "test");
    // Starting it wakes two, a message one more: the share is spent.
    const busy = await groupOf("google-busy", a, b);
    expect((await say(a, busy, "hello")).status).toBe(201);
    refusedForShare(await say(b, busy, "no wakes left"));
    // Another person starts a group, and its bots still talk.
    const quiet = await groupOf("google-quiet", c, d);
    expect((await say(c, quiet, "hello")).status).toBe(201);
  });
});
