import { beforeEach, describe, expect, it } from "vitest";
import { POST as eventsRoute } from "@/app/v1/events/route";
import { GET as wakeRoute } from "@/app/v1/me/wake/route";
import { POST as sendRoute } from "@/app/v1/messages/route";
import { setFrozen } from "@/lib/admin";
import { db } from "@/lib/db";
import { RUN_MAX, workDue } from "@/lib/due";
import { forgetDueMinute } from "@/lib/due-check";
import { startChannel } from "@/lib/private-channels";
import { SESSION_DEFAULT_NOTICE, SESSION_TIMES_MAX } from "@/lib/sessions";
import { call, register, resetDb } from "./helpers";

// A hackathon-sized rehearsal of wakes and sessions under the repo's
// default caps: nine bots in three groups, each group's leader setting a
// session every 15 minutes for three hours, and every member writing in its
// group each time it's woken, while the clock is run a minute at a time
// across the whole three hours. One member drops off (a moderator freezes
// it) halfway. What it holds: every meeting wakes every member that's still
// there exactly once, nothing is missed or capped, no run of the clock is
// cut at RUN_MAX, the dropped member's meetings are skipped as frozen and
// wake nobody, and each bot's wake number is exactly its meetings plus the
// messages others wrote while it was there. Every site-wide and per-person
// cap it touches is charged exactly once for each fire, message and wake,
// read back from rate_limits. The load sits far under the default caps, so
// what this holds is the counting, not a cap being reached. Production's
// caps are private and may differ; this holds the defaults.
//
// Simulated time comes from workDue's own clock, but session_items() drops
// an occurrence once the next one's due time has passed on the database's
// real now(), so this would lose meetings if it ever ran for more than
// about one session gap (15 minutes) of real time; its timeout fails it long
// before that.

beforeEach(async () => {
  await resetDb();
  forgetDueMinute();
});

type Bot = { handle: string; key: string; id: number };
const MIN = 60_000;
const EVERY = 15;
const TIMES = 12;

async function bot(handle: string): Promise<Bot> {
  const b = await register(handle);
  const [r] = await db()<{ id: string }[]>`
    UPDATE bots SET created_at = now() - interval '3 days'
    WHERE handle = ${handle} RETURNING id`;
  return { ...b, id: Number(r?.id) };
}

async function team(n: number) {
  const bots = [
    await bot(`lead${n}`),
    await bot(`ann${n}`),
    await bot(`ben${n}`),
  ];
  const auth = `google-team-${n}`;
  const [h] = await db()<{ id: string }[]>`
    INSERT INTO humans (auth_user_id) VALUES (${auth}) RETURNING id`;
  for (const b of bots)
    await db()`UPDATE bots SET owner_id = ${h?.id ?? null} WHERE id = ${b.id}`;
  const r = await startChannel(
    db(),
    auth,
    bots.map((b) => b.handle),
    bots[0]?.handle ?? "",
    null,
  );
  return { bots, channel: r.channel };
}

// How many meetings have woken each bot so far.
async function firedBy(): Promise<Map<number, number>> {
  const rows = await db()<{ bot_id: string; n: number }[]>`
    SELECT bot_id, count(*)::int AS n FROM event_fires
    WHERE outcome = 'fired' GROUP BY bot_id`;
  return new Map(rows.map((r) => [Number(r.bot_id), r.n]));
}

// Uses counted so far, by limit bucket, summed over windows (a run may
// straddle an hour).
async function uses(): Promise<Map<string, number>> {
  const rows = await db()<{ bucket: string; n: number }[]>`
    SELECT bucket, sum(count)::int AS n FROM rate_limits
    WHERE bucket LIKE 'event-fire:%' OR bucket LIKE 'channel-wake:%'
      OR bucket LIKE 'group-message:%'
    GROUP BY bucket`;
  return new Map(rows.map((r) => [r.bucket, r.n]));
}

const wake = async (b: Bot): Promise<number> =>
  (await call(wakeRoute, { key: b.key })).body.wake;

describe("a load rehearsal: nine bots, three groups, three hours", () => {
  it("wakes every member for every meeting, once, and nothing is lost when one drops off", async () => {
    expect(TIMES).toBeLessThanOrEqual(SESSION_TIMES_MAX);
    const teams = [await team(1), await team(2), await team(3)];
    const everyone = teams.flatMap((t) => t.bots);
    const start = new Map<number, number>();
    for (const b of everyone) start.set(b.id, await wake(b));

    // Each leader sets its group's sessions, a few minutes apart.
    const firsts: number[] = [];
    for (const [i, t] of teams.entries()) {
      const lead = t.bots[0] as Bot;
      const r = await call(eventsRoute, {
        key: lead.key,
        path: "/v1/events",
        body: {
          action: "session",
          channel: t.channel,
          in_minutes: 10 + i * 4,
          every_minutes: EVERY,
          times: TIMES,
        },
      });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.session.times).toBe(TIMES);
      firsts.push(Date.parse(r.body.session.at));
    }

    // The one who drops off: team 3's ann, frozen once its group's sixth
    // meeting has woken it.
    const dropper = teams[2]?.bots[1] as Bot;
    const dropAfter = (firsts[2] as number) + 5 * EVERY * MIN;
    let dropped = false;

    // What each bot should read as its wake number: meetings it was woken
    // for, and messages other members wrote while it was there.
    const expected = new Map(start);
    const bump = (id: number, n = 1) =>
      expected.set(id, (expected.get(id) ?? 0) + n);

    const last = Math.max(...firsts) + (TIMES - 1) * EVERY * MIN;
    const end = last + MIN;
    let fired = 0;
    let biggest = 0;
    let messages = 0;
    let messageWakes = 0;
    const capsBefore = await uses();
    let before = await firedBy();
    for (
      let t = Date.now() + MIN;
      t <= end + SESSION_DEFAULT_NOTICE * MIN;
      t += MIN
    ) {
      if (!dropped && t > dropAfter) {
        await setFrozen(db(), dropper.handle, true, "drops off");
        dropped = true;
      }
      const run = await workDue(new Date(t));
      expect(run.locked).toBe(false);
      expect(run.more).toBe(false);
      expect(run.capped).toBe(0);
      expect(run.missed).toBe(0);
      fired += run.fired;
      biggest = Math.max(biggest, run.fired + run.skipped + run.missed);
      if (run.fired === 0 && run.skipped === 0) continue;
      const after = await firedBy();
      // The groups meet minutes apart, so no bot has two meetings in one
      // run: each fire is one bot woken once.
      const woken = [...after.keys()].filter(
        (id) => (after.get(id) ?? 0) > (before.get(id) ?? 0),
      );
      for (const id of woken)
        expect((after.get(id) ?? 0) - (before.get(id) ?? 0)).toBe(1);
      expect(woken.length).toBe(run.fired);
      before = after;
      // Each woken member comes back and says something in its group.
      for (const id of woken) {
        bump(id);
        const mine = teams.find((x) => x.bots.some((b) => b.id === id));
        const me = mine?.bots.find((b) => b.id === id) as Bot;
        const said = await call(sendRoute, {
          key: me.key,
          body: { channel: mine?.channel, body: `Here at ${t}.` },
        });
        expect(said.status, JSON.stringify(said.body)).toBe(201);
        messages += 1;
        for (const other of mine?.bots ?? [])
          if (other.id !== id && !(dropped && other.id === dropper.id)) {
            bump(other.id);
            messageWakes += 1;
          }
      }
    }

    // Every meeting of every group woke each member that was there.
    const rows = await db()<
      { bot_id: string; outcome: string; reason: string | null; n: number }[]
    >`
      SELECT bot_id, outcome, reason, count(*)::int AS n FROM event_fires
      WHERE kind = 'session' GROUP BY bot_id, outcome, reason
      ORDER BY bot_id, outcome`;
    for (const b of everyone) {
      const mine = rows.filter((r) => Number(r.bot_id) === b.id);
      if (b.id === dropper.id) {
        expect(mine).toEqual([
          { bot_id: String(b.id), outcome: "fired", reason: null, n: 6 },
          { bot_id: String(b.id), outcome: "skipped", reason: "frozen", n: 6 },
        ]);
      } else {
        expect(mine).toEqual([
          { bot_id: String(b.id), outcome: "fired", reason: null, n: TIMES },
        ]);
      }
    }
    expect(fired).toBe(everyone.length * TIMES - 6);
    expect(rows.some((r) => r.outcome === "missed")).toBe(false);
    expect(rows.some((r) => r.reason === "cap")).toBe(false);

    // Each bot's wake number is exactly what reached it. The frozen bot
    // reads nothing while frozen: unfreeze to read where it stopped.
    await setFrozen(db(), dropper.handle, false, "back");
    for (const b of everyone)
      expect(await wake(b), b.handle).toBe(expected.get(b.id));

    // No run of the clock came near the batch it can work at once.
    expect(biggest).toBeGreaterThan(0);
    expect(biggest).toBeLessThanOrEqual(teams[0]?.bots.length ?? 0);
    expect(biggest * 10).toBeLessThan(RUN_MAX);

    // Each cap was charged exactly once for each fire, message and wake:
    // fires against event_fire_global, and with the messages' wakes
    // against channel_wake_global; each message against its person's share
    // and the site-wide group cap, and its wakes against its person's share.
    const capsAfter = await uses();
    const delta = (b: string) =>
      (capsAfter.get(b) ?? 0) - (capsBefore.get(b) ?? 0);
    const sumOf = (prefix: string) =>
      [...capsAfter.keys()]
        .filter((b) => b.startsWith(prefix) && !b.endsWith(":all"))
        .reduce((n, b) => n + delta(b), 0);
    expect(delta("event-fire:all")).toBe(fired);
    expect(delta("channel-wake:all")).toBe(fired + messageWakes);
    expect(sumOf("channel-wake:")).toBe(messageWakes);
    expect(delta("group-message:all")).toBe(messages);
    expect(sumOf("group-message:")).toBe(messages);
  }, 300_000);
});
