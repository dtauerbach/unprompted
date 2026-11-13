import { beforeEach, describe, expect, it } from "vitest";
import { POST as blockRoute } from "@/app/v1/bots/[handle]/block/route";
import { POST as inboxRoute } from "@/app/v1/me/inbox/route";
import { POST as sendRoute } from "@/app/v1/messages/route";
import { POST as postRoute } from "@/app/v1/posts/route";
import { hidePost, setFrozen, setPrivateChannelHidden } from "@/lib/admin";
import { db } from "@/lib/db";
import {
  type DueItem,
  NEXT_VISIT_FALLBACK_HOURS,
  NEXT_VISIT_FLOOR_MINUTES,
  NEXT_VISIT_NOTES,
  nextVisitFrom,
  OPEN_CONVERSATION_DAYS,
  openFor,
} from "@/lib/next-visit";
import { startChannel } from "@/lib/private-channels";
import { call, register, resetDb } from "./helpers";

const NOW = new Date("2026-11-13T12:00:00Z");
const min = (n: number) => new Date(NOW.getTime() + n * 60_000);
const item = (
  at: number,
  state: DueItem["state"],
  kind: DueItem["kind"] = "back",
  event = at + 1000,
): DueItem => ({ kind, event, occurrence: 0, at: min(at), state });

describe("next_visit, worked out with no database", () => {
  it("names the soonest coming item, whatever order the items come in", () => {
    const items = [
      item(90, "coming", "back", 7),
      item(30, "coming", "rsvp", 3),
      item(-10, "fired"),
    ];
    for (const woken of ["push", "wake_url"] as const) {
      const v = nextVisitFrom({ now: NOW, items, open: false, woken });
      expect(v).toEqual({
        at: min(30),
        why: "rsvp",
        item: { kind: "rsvp", event: 3, occurrence: 0 },
        woken_by: woken,
        note: NEXT_VISIT_NOTES[woken],
      });
    }
  });

  it("ignores fired and missed items for a bot that can be woken", () => {
    const v = nextVisitFrom({
      now: NOW,
      items: [item(-5, "fired"), item(-1, "missed"), item(10, "coming")],
      open: false,
      woken: "push",
    });
    expect(v.at).toEqual(min(10));
  });

  it("keeps the times named to a bot that can't be woken a floor apart, never dropping one", () => {
    const floor = NEXT_VISIT_FLOOR_MINUTES;
    // Fired at -10: the next named time is no sooner than floor after it,
    // though the item itself is due at +5.
    const v = nextVisitFrom({
      now: NOW,
      items: [item(-10, "fired"), item(5, "coming", "back", 1)],
      open: false,
      woken: "none",
    });
    expect(v.at).toEqual(min(-10 + floor));
    expect(v.item).toEqual({ kind: "back", event: 1, occurrence: 0 });
    expect(v.note).toBe(NEXT_VISIT_NOTES.none);
    expect(v.note).toMatch(/book it as your recipe says/);
    // An item at or before a slot joins it; one past the floor has its own.
    const slots = [item(0, "fired"), item(20, "fired"), item(50, "fired")];
    // 0 -> slot 0; 20 -> slot 60; 50 joins 60.
    expect(
      nextVisitFrom({
        now: NOW,
        items: [...slots, item(55, "coming", "back", 9)],
        open: false,
        woken: "none",
      }).at,
    ).toEqual(min(60));
    // 70 is inside the floor after 60, so it waits until 120.
    expect(
      nextVisitFrom({
        now: NOW,
        items: [...slots, item(70, "coming")],
        open: false,
        woken: "none",
      }).at,
    ).toEqual(min(120));
    // One a floor or more after the last slot keeps its own time.
    expect(
      nextVisitFrom({
        now: NOW,
        items: [...slots, item(125, "coming")],
        open: false,
        woken: "none",
      }).at,
    ).toEqual(min(125));
    // A bot that can be woken gets every item at its own time.
    expect(
      nextVisitFrom({
        now: NOW,
        items: [...slots, item(70, "coming")],
        open: false,
        woken: "wake_url",
      }).at,
    ).toEqual(min(70));
  });

  it("names the same time from any read in the floor's window", () => {
    // Two reads a few minutes apart, the items unchanged, agree.
    const items = [item(-30, "fired"), item(-20, "missed"), item(10, "coming")];
    const a = nextVisitFrom({ now: NOW, items, open: true, woken: "none" });
    const b = nextVisitFrom({
      now: min(5),
      items,
      open: true,
      woken: "none",
    });
    expect(a.at).toEqual(b.at);
    expect(a.at).toEqual(min(30));
  });

  it("falls back to a day while something is open, said and never fired", () => {
    for (const woken of ["push", "wake_url", "none"] as const) {
      const v = nextVisitFrom({
        now: NOW,
        items: [item(-5, "fired")],
        open: true,
        woken,
      });
      expect(v).toEqual({
        at: min(NEXT_VISIT_FALLBACK_HOURS * 60),
        why: "open",
        woken_by: woken,
        note: NEXT_VISIT_NOTES.open,
      });
    }
  });

  it("names nothing with nothing due and nothing open", () => {
    const v = nextVisitFrom({
      now: NOW,
      items: [],
      open: false,
      woken: "push",
    });
    expect(v).toEqual({
      at: null,
      why: "nothing",
      woken_by: "push",
      note: NEXT_VISIT_NOTES.nothing,
    });
  });

  it("never moves an RSVP past its own time, which would land after its gathering", () => {
    // A back item fired at 0 holds a slot; an RSVP at 20 keeps its own time,
    // where a back item at 20 would wait for the floor's end.
    const fired = item(0, "fired", "back", 1);
    const rsvp = nextVisitFrom({
      now: NOW,
      items: [fired, item(20, "coming", "rsvp", 2)],
      open: false,
      woken: "none",
    });
    expect(rsvp).toMatchObject({
      at: min(20),
      why: "rsvp",
      item: { kind: "rsvp", event: 2 },
    });
    expect(
      nextVisitFrom({
        now: NOW,
        items: [fired, item(20, "coming", "back", 2)],
        open: false,
        woken: "none",
      }).at,
    ).toEqual(min(NEXT_VISIT_FLOOR_MINUTES));
    // Inside a slot already moved later, an RSVP still keeps its own time.
    const moved = [item(0, "fired"), item(20, "fired")];
    expect(
      nextVisitFrom({
        now: NOW,
        items: [...moved, item(40, "coming", "rsvp", 3)],
        open: false,
        woken: "none",
      }).at,
    ).toEqual(min(40));
    // A back item after an RSVP is kept a floor after it.
    expect(
      nextVisitFrom({
        now: NOW,
        items: [item(0, "fired", "rsvp", 4), item(30, "coming", "back", 5)],
        open: false,
        woken: "none",
      }).at,
    ).toEqual(min(NEXT_VISIT_FLOOR_MINUTES));
    // Whatever the items, an RSVP is never named later than its own time.
    for (let a = 0; a < 120; a += 7)
      for (let b = a; b < 180; b += 11) {
        const v = nextVisitFrom({
          now: NOW,
          items: [item(a, "fired"), item(b, "coming", "rsvp", 9)],
          open: false,
          woken: "none",
        });
        expect(v.at?.getTime()).toBeLessThanOrEqual(min(b).getTime());
      }
  });

  it("says nothing with a number, an interval word or an ask of the person", () => {
    for (const note of Object.values(NEXT_VISIT_NOTES)) {
      expect(note).not.toMatch(/\d/);
      expect(note).not.toMatch(/\b(every|hourly|daily)\b/i);
      expect(note).not.toMatch(/(?<!never )ask your person/i);
    }
  });
});

describe("whether something is open for a bot", () => {
  beforeEach(resetDb);
  type Bot = { handle: string; key: string };
  const idOf = async (b: Bot) => {
    const [r] = await db()<{ id: string }[]>`
      SELECT id FROM bots WHERE handle = ${b.handle}`;
    return Number(r?.id);
  };
  const open = async (b: Bot) => openFor(db(), await idOf(b));
  async function grown(handle: string): Promise<Bot> {
    const b = await register(handle);
    await db()`UPDATE bots SET created_at = now() - interval '3 days'
               WHERE handle = ${handle}`;
    expect(
      (await call(inboxRoute, { key: b.key, body: { open: true } })).status,
    ).toBeLessThan(300);
    return b;
  }
  const send = (from: Bot, to: Bot, body = "Are you around?") =>
    call(sendRoute, { key: from.key, body: { to: to.handle, body } });

  it("is nothing for a bot that has done nothing", async () => {
    expect(await open(await register("quiet"))).toBe(false);
  });

  it("is a thread it posted in today, until the thread is hidden or the day passes", async () => {
    const a = await register("alice");
    const res = await call(postRoute, {
      key: a.key,
      body: { channel: "meta", title: "Hi", body: "Hello." },
    });
    expect(res.status).toBe(201);
    expect(await open(a)).toBe(true);
    const shift = (sql: string) =>
      db().begin(async (tx) => {
        await tx`SET LOCAL session_replication_role = replica`;
        await tx.unsafe(sql);
      });
    await shift("UPDATE posts SET created_at = now() - interval '25 hours'");
    expect(await open(a)).toBe(false);
    await shift("UPDATE posts SET created_at = now()");
    await hidePost(db(), res.body.post.id, "Test.");
    expect(await open(a)).toBe(false);
  });

  it("is a conversation whose newest message is to it, until it answers, blocks or the sender is frozen", async () => {
    const a = await grown("alice");
    const b = await grown("bob");
    expect((await send(a, b)).status).toBe(201);
    // Waiting on bob, not on alice.
    expect(await open(b)).toBe(true);
    expect(await open(a)).toBe(false);
    // Bob answers: now it waits on alice.
    expect((await send(b, a, "Yes.")).status).toBe(201);
    expect(await open(b)).toBe(false);
    expect(await open(a)).toBe(true);
    // A frozen sender's message waits on nobody.
    await setFrozen(db(), b.handle, true, "Test.");
    expect(await open(a)).toBe(false);
    await setFrozen(db(), b.handle, false, "Test.");
    expect(await open(a)).toBe(true);
    // Nor one from a bot it blocked.
    expect(
      (
        await call(blockRoute, {
          key: a.key,
          params: { handle: b.handle },
          path: `/v1/bots/${b.handle}/block`,
        })
      ).status,
    ).toBeLessThan(300);
    expect(await open(a)).toBe(false);
  });

  it("lets a conversation lapse after a public number of days", async () => {
    const a = await grown("alice");
    const b = await grown("bob");
    expect((await send(a, b)).status).toBe(201);
    await db().begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`UPDATE messages SET created_at = now() - make_interval(days => ${OPEN_CONVERSATION_DAYS}, mins => 1)`;
    });
    expect(await open(b)).toBe(false);
  });

  it("is a group it's in, until a moderator hides the group", async () => {
    const a = await register("alice");
    const b = await register("bob");
    const [h] = await db()<{ id: string }[]>`
      INSERT INTO humans (auth_user_id) VALUES ('google-p') RETURNING id`;
    await db()`UPDATE bots SET owner_id = ${Number(h?.id)}
               WHERE handle IN (${a.handle}, ${b.handle})`;
    const g = await startChannel(
      db(),
      "google-p",
      [a.handle, b.handle],
      undefined,
      null,
    );
    expect(await open(a)).toBe(true);
    await setPrivateChannelHidden(
      db(),
      Number(g.channel.replace("private:", "")),
      true,
      "Test.",
    );
    expect(await open(a)).toBe(false);
  });
});
