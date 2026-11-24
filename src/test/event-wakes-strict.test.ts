import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as rsvpRoute } from "@/app/v1/gatherings/[id]/rsvp/route";
import { GET as catchUpRoute } from "@/app/v1/me/catch-up/route";
import { GET as digestRoute } from "@/app/v1/me/digest/route";
import { POST as pushRoute } from "@/app/v1/me/push/route";
import { db } from "@/lib/db";
import { checkDue, forgetDueMinute } from "@/lib/due-check";
import { useDeliver } from "@/lib/push";
import { call, register, resetDb } from "./helpers";

// The strict case for an event's wake (EV12b, Dot's R225 checklist for
// PR 195). evals/event-wakes.scenarios.ts drives a running site on the wall
// clock, so it can only hold a wake to its cron margin: a clock minute plus
// the run's own seconds. Here one controlled clock gives the time a guest is
// due (T, from its RSVP's own answer), the production check's decision
// (checkDue, the code /v1/clock and every request run) and when the counted
// receiver got the push, so a wake is held to [T, T + 60s) exactly.
//
// The receiver is the drain's deliverer, standing in for a push URL's
// listener: an arrival there is a push sent, not a run started. The strict
// window and the eval's cron margin are named apart so one can't hide the
// other.

const MIN = 60_000;
// A wake is on time when it arrives in [T, T + STRICT_WINDOW_MS).
const STRICT_WINDOW_MS = 60_000;
// The eval's tolerance on the wall clock: a minute plus a run's seconds.
const CRON_MARGIN_MS = 75_000;
const strictOnTime = (arrival: number, t: number) =>
  arrival >= t && arrival - t < STRICT_WINDOW_MS;
const withinCronMargin = (arrival: number, t: number) =>
  arrival >= t && arrival - t < CRON_MARGIN_MS;

type Bot = { handle: string; key: string };
type Arrival = { url: string; body: string; at: number };

// The controlled clock. Every check is called with it, and the receiver
// stamps each arrival with it.
const clock = { now: 0 };
let arrivals: Arrival[] = [];

beforeEach(async () => {
  await resetDb();
  forgetDueMinute();
  arrivals = [];
  useDeliver(async (url, body) => {
    arrivals.push({ url, body, at: clock.now });
    return { status: 204 };
  });
});
afterEach(() => useDeliver(null));

const GUEST_URL = "https://hooks.example.org/guest";
const CONTROL_URL = "https://hooks.example.org/control";

async function withPush(name: string, url: string): Promise<Bot> {
  const b = await register(name);
  const set = await call(pushRoute, { key: b.key, body: { url } });
  expect(set.status, JSON.stringify(set.body)).toBe(201);
  return b;
}

// A gathering written straight to the table, starting at an exact time, so
// the guest's T can sit anywhere in a minute.
async function gatheringAt(host: Bot, startsAt: number): Promise<number> {
  const [g] = await db()<{ id: string }[]>`
    INSERT INTO gatherings (bot_id, key_id, title, starts_at, created_at)
    SELECT b.id, k.id, 'Strict', ${new Date(startsAt)}, now() - interval '1 hour'
    FROM bots b JOIN api_keys k ON k.bot_id = b.id AND k.revoked_at IS NULL
    WHERE b.handle = ${host.handle}
    RETURNING id`;
  return Number(g?.id);
}

const rsvp = (b: Bot, id: number, body: object) =>
  call(rsvpRoute, {
    key: b.key,
    body,
    params: { id: String(id) },
    path: `/v1/gatherings/${id}/rsvp`,
  });

async function wakeOf(b: Bot): Promise<number> {
  const [r] = await db()<{ count: string }[]>`
    SELECT w.count FROM wake_counters w JOIN bots b ON b.id = w.bot_id
    WHERE b.handle = ${b.handle}`;
  return Number(r?.count ?? 0);
}

type Due = { kind: string; event: number; state: string; at: string };
async function dueOf(b: Bot): Promise<Due[]> {
  const d = await call(digestRoute, {
    key: b.key,
    path: "/v1/me/digest?since=0",
  });
  expect(d.status).toBe(200);
  return d.body.due as Due[];
}

async function firesFor(b: Bot) {
  return db()<{ event_id: string; due_at: Date; outcome: string }[]>`
    SELECT f.event_id, f.due_at, f.outcome FROM event_fires f
    JOIN bots b ON b.id = f.bot_id WHERE b.handle = ${b.handle}
    ORDER BY f.id`;
}

// A host, a guest coming with 15 minutes' notice, and a control that said
// it was coming and withdrew. T is `offset` ms past a minute boundary at
// least 20 minutes off, so the RSVP is in good time.
async function scene(offset: number) {
  const host = await register("host");
  const guest = await withPush("guest", GUEST_URL);
  const control = await withPush("control", CONTROL_URL);
  const boundary = Math.ceil((Date.now() + 20 * MIN) / MIN) * MIN;
  const startsAt = boundary + offset + 15 * MIN;
  const id = await gatheringAt(host, startsAt);
  const r = await rsvp(guest, id, { going: true, notice_minutes: 15 });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body.rsvp.woken_by).toBe("push");
  // T as the site told the guest.
  const t = Date.parse(r.body.rsvp.wake_at);
  expect(t).toBe(boundary + offset);
  for (const going of [true, false]) {
    const c = await rsvp(
      control,
      id,
      going ? { going, notice_minutes: 15 } : { going },
    );
    expect(c.status).toBe(200);
  }
  return {
    host,
    guest,
    control,
    id,
    t,
    startsAt,
    guestWake: await wakeOf(guest),
    controlWake: await wakeOf(control),
  };
}

// The production check at a time on the controlled clock, as a check in a
// minute no request has checked yet.
async function tick(at: number) {
  clock.now = at;
  forgetDueMinute();
  return checkDue(at);
}

const toGuest = () => arrivals.filter((a) => a.url === GUEST_URL);
const toControl = () => arrivals.filter((a) => a.url === CONTROL_URL);

// What the guest reads once it's woken: its own gathering, once, with its
// answer, and its own due item, fired at T. What the control reads:
// nothing of either.
async function checkReads(s: Awaited<ReturnType<typeof scene>>) {
  const caught = await call(catchUpRoute, {
    key: s.guest.key,
    path: "/v1/me/catch-up",
  });
  expect(caught.status).toBe(200);
  const mine = (
    caught.body.gatherings as {
      id: number;
      starts_at: string;
      going?: boolean;
    }[]
  ).filter((g) => g.id === s.id);
  expect(mine).toHaveLength(1);
  expect(Date.parse(mine[0]?.starts_at ?? "")).toBe(s.startsAt);
  expect(mine[0]?.going).toBe(true);
  const due = (await dueOf(s.guest)).filter((d) => d.kind === "rsvp");
  expect(due).toEqual([
    expect.objectContaining({ event: s.id, state: "fired" }),
  ]);
  expect(Date.parse(due[0]?.at ?? "")).toBe(s.t);
  const rows = await firesFor(s.guest);
  expect(rows.map((r) => [Number(r.event_id), r.outcome])).toEqual([
    [s.id, "fired"],
  ]);
  expect(rows[0]?.due_at.getTime()).toBe(s.t);

  expect(await dueOf(s.control)).toEqual([]);
  expect(await firesFor(s.control)).toEqual([]);
  const controlCaught = await call(catchUpRoute, {
    key: s.control.key,
    path: "/v1/me/catch-up",
  });
  const theirs = (
    controlCaught.body.gatherings as { id: number; going?: boolean }[]
  ).filter((g) => g.id === s.id);
  for (const g of theirs) expect(g.going).not.toBe(true);
}

// One push to the guest, with the guest's handle and new number; none to
// the control, whose number never moved.
async function checkCounters(s: Awaited<ReturnType<typeof scene>>) {
  expect(toGuest()).toHaveLength(1);
  expect(await wakeOf(s.guest)).toBe(s.guestWake + 1);
  expect(JSON.parse(toGuest()[0]?.body ?? "{}")).toMatchObject({
    bot: s.guest.handle,
    wake: s.guestWake + 1,
  });
  expect(toControl()).toHaveLength(0);
  expect(await wakeOf(s.control)).toBe(s.controlWake);
}

describe("an event's wake on a controlled clock: [T, T + 60s)", () => {
  it("a check one millisecond before T sends nothing", async () => {
    const s = await scene(30_000);
    expect(await tick(s.t - 1)).toBe("not_due");
    expect(arrivals).toEqual([]);
    expect(await wakeOf(s.guest)).toBe(s.guestWake);
    expect(await firesFor(s.guest)).toEqual([]);
    const due = (await dueOf(s.guest)).filter((d) => d.kind === "rsvp");
    expect(due).toEqual([
      expect.objectContaining({ event: s.id, state: "coming" }),
    ]);
  });

  it("a check at exactly T sends the push, arriving at T", async () => {
    const s = await scene(30_000);
    expect(await tick(s.t)).toBe("worked");
    const got = toGuest()[0];
    expect(got?.at).toBe(s.t);
    expect(strictOnTime(got?.at ?? Number.NaN, s.t)).toBe(true);
    await checkCounters(s);
    await checkReads(s);
  });

  it("a first check at T + 59,999 ms sends it, still inside the strict window", async () => {
    const s = await scene(0);
    expect(await tick(s.t + 59_999)).toBe("worked");
    const got = toGuest()[0];
    expect(got?.at).toBe(s.t + 59_999);
    expect(strictOnTime(got?.at ?? Number.NaN, s.t)).toBe(true);
    await checkCounters(s);
    await checkReads(s);
  });

  it("a first check at T + 60,000 ms still sends it, which fails the strict window and passes the cron margin", async () => {
    const s = await scene(0);
    expect(await tick(s.t + 60_000)).toBe("worked");
    const got = toGuest()[0];
    expect(got?.at).toBe(s.t + 60_000);
    // The receiver's own arrival, held to each rule by name.
    expect(strictOnTime(got?.at ?? Number.NaN, s.t)).toBe(false);
    expect(withinCronMargin(got?.at ?? Number.NaN, s.t)).toBe(true);
    await checkCounters(s);
  });

  // A cron that calls the clock once a minute, at the same second each
  // minute: the first tick at or after T sends the push, so it arrives in
  // [T, T + 60s) wherever T falls in its minute, and the ticks after it
  // send nothing more.
  for (const offset of [0, 1, 30_000, 59_999])
    for (const jitter of [0, 7_000])
      it(`a cron each minute wakes the guest once inside [T, T + 60s) (T ${offset} ms into its minute, ticks ${jitter} ms in)`, async () => {
        const s = await scene(offset);
        const first = Math.floor(s.t / MIN) * MIN - 2 * MIN + jitter;
        // The clock tick that sent it, the arrival, and the first read that
        // showed it fired, each kept apart.
        let sentBy: number | null = null;
        let firstGoodRead: number | null = null;
        for (let at = first; at < s.t + 3 * MIN; at += MIN) {
          const before = toGuest().length;
          await tick(at);
          if (toGuest().length > before && sentBy === null) sentBy = at;
          if (
            firstGoodRead === null &&
            (await dueOf(s.guest)).some(
              (d) => d.event === s.id && d.state === "fired",
            )
          )
            firstGoodRead = at;
        }
        const arrival = toGuest()[0]?.at ?? Number.NaN;
        expect(sentBy).not.toBeNull();
        expect(arrival).toBe(sentBy);
        expect(firstGoodRead).toBe(sentBy);
        expect(strictOnTime(arrival, s.t)).toBe(true);
        // The tick before it was before T.
        expect(arrival - MIN).toBeLessThan(s.t);
        // Two more ticks after it changed nothing.
        await checkCounters(s);
        await checkReads(s);
      });
});
