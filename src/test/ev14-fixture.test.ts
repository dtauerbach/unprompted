import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as rsvpRoute } from "@/app/v1/gatherings/[id]/rsvp/route";
import {
  POST as announceRoute,
  GET as listRoute,
} from "@/app/v1/gatherings/route";
import { GET as catchUpRoute } from "@/app/v1/me/catch-up/route";
import { db } from "@/lib/db";
import { workDue } from "@/lib/due";
import { forgetDueMinute } from "@/lib/due-check";
import { call, linkBot, register, resetDb } from "./helpers";

// EV14b: the gathering fixture of EV14 (a host, a guest coming with five
// minutes' notice, a bot that never answers), carried on past where the
// first run stopped: the clock fires the guest's notice and the start, and
// a second gathering that needs one and has nobody coming ends short at its
// decision, waking no one. A guest that withdrew has no due items for it.
// The clock is stepped with workDue(at), so issued_at is the run's real
// time, not the stepped one, and a gathering's state by the clock
// (upcoming, starting, over) is worked out on the real one: those are left
// out of what's checked. An item's state and a gathering that ended early
// (short) don't hang on the clock, and are checked.

vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  connection: async () => {},
}));

beforeEach(async () => {
  await resetDb();
  forgetDueMinute();
});

type Bot = { handle: string; key: string };
const MIN = 60_000;

// A host the default announce gate lets through: linked and past new.
async function trusted(handle: string): Promise<Bot> {
  const bot = await register(handle);
  await linkBot(bot.key, `google-${handle}`);
  await db()`UPDATE bots SET created_at = now() - interval '3 days' WHERE handle = ${bot.handle}`;
  return bot;
}

async function announce(host: Bot, title: string, inMinutes: number) {
  const res = await call(announceRoute, {
    key: host.key,
    body: {
      title,
      starts_at: new Date(Date.now() + inMinutes * MIN).toISOString(),
      needs: 1,
    },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return {
    id: res.body.gathering.id as number,
    start: Date.parse(res.body.gathering.starts_at),
  };
}

const rsvp = (b: Bot, id: number, body: object) =>
  call(rsvpRoute, {
    key: b.key,
    body,
    params: { id: String(id) },
    path: `/v1/gatherings/${id}/rsvp`,
  });

async function catchUp(b: Bot) {
  const res = await call(catchUpRoute, {
    key: b.key,
    path: "/v1/me/catch-up?since=0",
  });
  expect(res.status).toBe(200);
  return res.body;
}

// A bot's due items for one gathering, without issued_at (see above).
// biome-ignore lint/suspicious/noExplicitAny: catch_up's JSON
const dueFor = (view: any, id: number) =>
  // biome-ignore lint/suspicious/noExplicitAny: catch_up's JSON
  (view.due as any[])
    .filter((i) => i.event === id)
    .map(({ kind, at, state }) => ({ kind, at, state }));

// biome-ignore lint/suspicious/noExplicitAny: catch_up's JSON
const listed = (view: any, id: number) =>
  // biome-ignore lint/suspicious/noExplicitAny: catch_up's JSON
  (view.gatherings as any[]).find((g) => g.id === id);

async function wakeOf(b: Bot): Promise<number> {
  const [r] = await db()<{ count: string }[]>`
    SELECT w.count FROM wake_counters w JOIN bots b ON b.id = w.bot_id
    WHERE b.handle = ${b.handle}`;
  return Number(r?.count ?? 0);
}

const iso = (ms: number) => new Date(ms).toISOString();

describe("EV14b: a gathering through its notice, its start and a short end", () => {
  it("fires the guest's notice and start, and ends an empty gathering short waking no one", async () => {
    const host = await trusted("ev14-host");
    const guest = await register("ev14-guest");
    const control = await register("ev14-control");

    // Gathering one: the guest is coming, with five minutes' notice.
    const one = await announce(host, "EV14 synthetic gathering", 20);
    const said = await rsvp(guest, one.id, {
      going: true,
      notice_minutes: 5,
    });
    expect(said.status).toBe(200);
    expect(said.body.rsvp).toMatchObject({
      wake_at: iso(one.start - 5 * MIN),
      woken_by: "none",
      next_visit: { at: iso(one.start - 5 * MIN), why: "rsvp" },
    });

    // Gathering two, same needs, 40 minutes out, so its decision falls
    // after gathering one's start: the guest says it's coming, then
    // withdraws, so nobody is coming at its decision.
    const two = await announce(host, "EV14 empty gathering", 40);
    expect(
      (await rsvp(guest, two.id, { going: true, notice_minutes: 5 })).status,
    ).toBe(200);
    const left = await rsvp(guest, two.id, { going: false });
    expect(left.status).toBe(200);
    expect(left.body.rsvp.wake_at).toBeNull();
    expect(left.body.gathering).toMatchObject({ coming: 0, going: false });

    // Muse 743 item 3: after withdrawing, the guest still sees the
    // gathering in its list, not coming, and has no due item for it.
    let seen = await catchUp(guest);
    expect(listed(seen, two.id)).toMatchObject({ coming: 0, going: false });
    expect(dueFor(seen, two.id)).toEqual([]);
    expect(dueFor(seen, one.id)).toEqual([
      { kind: "rsvp", at: iso(one.start - 5 * MIN), state: "coming" },
      { kind: "start", at: iso(one.start), state: "coming" },
    ]);
    expect(seen.next_visit).toMatchObject({
      at: iso(one.start - 5 * MIN),
      why: "rsvp",
    });

    // Gathering one's decision, 15 minutes before its start: one coming of
    // one needed, so it stands, and nothing fires yet.
    const decideOne = await workDue(new Date(one.start - 15 * MIN + 1000));
    expect(decideOne).toMatchObject({ shorts: 0, fired: 0, missed: 0 });

    // Muse 743 item 4: the notice fires at start minus five, and the
    // guest's wake number rises once. next_visit moves on to the start.
    const before = {
      guest: await wakeOf(guest),
      host: await wakeOf(host),
      control: await wakeOf(control),
    };
    expect(before.guest).toBe(0);
    const notice = await workDue(new Date(one.start - 5 * MIN + 1000));
    expect(notice).toMatchObject({
      fired: 1,
      skipped: 0,
      missed: 0,
      shorts: 0,
    });
    expect(await wakeOf(guest)).toBe(1);
    seen = await catchUp(guest);
    expect(seen.wake).toBe(1);
    expect(dueFor(seen, one.id)).toEqual([
      { kind: "rsvp", at: iso(one.start - 5 * MIN), state: "fired" },
      { kind: "start", at: iso(one.start), state: "coming" },
    ]);
    // Muse 743 item 2: the start is its own item and its own return.
    expect(seen.next_visit).toMatchObject({
      at: iso(one.start),
      why: "start",
      item: { kind: "start", event: one.id },
    });

    // The start fires too, a second wake.
    const started = await workDue(new Date(one.start + 1000));
    expect(started).toMatchObject({
      fired: 1,
      skipped: 0,
      missed: 0,
      shorts: 0,
    });
    expect(await wakeOf(guest)).toBe(2);
    seen = await catchUp(guest);
    expect(dueFor(seen, one.id).map((i) => i.state)).toEqual([
      "fired",
      "fired",
    ]);
    expect(seen.next_visit).toMatchObject({ at: null, why: "nothing" });

    // Gathering two's decision: nobody coming of one needed, so the clock
    // ends it short. Nobody was coming when it was written, so nobody is
    // woken: not the withdrawn guest, the host or the bot that never
    // answered.
    const decideTwo = await workDue(new Date(two.start - 15 * MIN + 1000));
    expect(decideTwo).toMatchObject({ shorts: 1, fired: 0, missed: 0 });
    const [end] = await db()<{ kind: string }[]>`
      SELECT kind FROM gathering_ends WHERE gathering_id = ${two.id}`;
    expect(end?.kind).toBe("short");
    expect(await wakeOf(guest)).toBe(2);
    expect(await wakeOf(host)).toBe(before.host);
    expect(await wakeOf(control)).toBe(before.control);

    // Its start passes with nothing to fire. The host's view and the
    // public list say short; the guest's view drops it.
    expect(await workDue(new Date(two.start + 1000))).toMatchObject({
      fired: 0,
      skipped: 0,
      missed: 0,
      shorts: 0,
    });
    seen = await catchUp(guest);
    expect(dueFor(seen, two.id)).toEqual([]);
    // Ended and not its own or one it's coming to, it leaves the guest's
    // list of what's new.
    expect(listed(seen, two.id)).toBeUndefined();
    const hostView = await catchUp(host);
    expect(listed(hostView, two.id)).toMatchObject({
      state: "short",
      coming: 0,
      needs: 1,
    });
    const controlList = await call(listRoute, {
      key: control.key,
      path: "/v1/gatherings",
    });
    expect(controlList.status).toBe(200);
    const inList = (
      controlList.body.gatherings as { id: number; state: string }[]
    ).find((x) => x.id === two.id);
    expect(inList).toMatchObject({ state: "short", coming: 0, needs: 1 });
    const shown = JSON.stringify(controlList.body);
    expect(shown).not.toContain(guest.handle);

    // One row per item, and each once: two fires for the guest, and none
    // for the short end, which wakes no one.
    const rows = await db()<{ kind: string; outcome: string }[]>`
      SELECT kind, outcome FROM event_fires ORDER BY id`;
    expect(rows).toEqual([
      { kind: "rsvp", outcome: "fired" },
      { kind: "start", outcome: "fired" },
    ]);
  });
});
