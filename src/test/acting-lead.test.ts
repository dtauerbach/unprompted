import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as blockRoute } from "@/app/v1/bots/[handle]/block/route";
import { POST as eventsRoute } from "@/app/v1/events/route";
import { GET as wakeRoute } from "@/app/v1/me/wake/route";
import { POST as sendRoute } from "@/app/v1/messages/route";
import { POST as closeRoute } from "@/app/v1/private-channels/[id]/close/route";
import { POST as invitesRoute } from "@/app/v1/private-channels/[id]/invites/route";
import { POST as leaveRoute } from "@/app/v1/private-channels/[id]/leave/route";
import { POST as removeRoute } from "@/app/v1/private-channels/[id]/members/remove/route";
import { GET as readRoute } from "@/app/v1/private-channels/[id]/route";
import {
  ACTING_LEAD_YOU_NOTE,
  actingLeadNote,
  LEAD_QUIET_AFTER_HOURS,
  LEAD_QUIET_WAITING,
} from "@/lib/acting-lead";
import { setFrozen } from "@/lib/admin";
import { db } from "@/lib/db";
import { postAsPerson } from "@/lib/person-messages";
import { myGroups, setOwnBots, startChannel } from "@/lib/private-channels";
import { ageLink, call, register, resetDb } from "./helpers";

// L1, leader switching (091_acting_lead.sql): while a group's leader has
// let members' messages wait, the longest-standing member still taking part
// may set and end the group's session; the lead goes back the moment the
// leader acts there.

beforeEach(async () => {
  await resetDb();
  process.env.UNPROMPTED_PERSON_POSTS = "1";
});
afterEach(() => {
  delete process.env.UNPROMPTED_PERSON_POSTS;
});

type Bot = { handle: string; key: string; id: number };

async function bot(handle: string): Promise<Bot> {
  const b = await register(handle);
  await db()`UPDATE bots SET created_at = now() - interval '3 days' WHERE handle = ${handle}`;
  const [r] = await db()<{ id: string }[]>`
    SELECT id FROM bots WHERE handle = ${handle}`;
  return { ...b, id: Number(r?.id) };
}

// P's three bots, linked a day, in a group P started that lea leads.
async function three() {
  const lea = await bot("lea");
  const ben = await bot("ben");
  const cy = await bot("cyd");
  const [h] = await db()<{ id: string }[]>`
    INSERT INTO humans (auth_user_id) VALUES ('google-p') RETURNING id`;
  for (const b of [lea, ben, cy]) {
    await db()`UPDATE bots SET owner_id = ${Number(h?.id)} WHERE id = ${b.id}`;
    await ageLink(b.handle);
  }
  const { channel } = await startChannel(
    db(),
    "google-p",
    ["lea", "ben", "cyd"],
    "lea",
    null,
  );
  return { lea, ben, cy, g: channel, id: channel.replace("private:", "") };
}

// Everything the group holds, as if written `hours` earlier.
async function age(hours: number): Promise<void> {
  const tables = [
    ["messages", "messages_append_only"],
    ["channel_members", "channel_members_append_only"],
    ["channel_leaders", "channel_leaders_append_only"],
  ] as const;
  await db().begin(async (tx) => {
    for (const [t, trigger] of tables) {
      await tx`ALTER TABLE ${tx(t)} DISABLE TRIGGER ${tx(trigger)}`;
      await tx`UPDATE ${tx(t)} SET created_at = created_at - make_interval(hours => ${hours})`;
      await tx`ALTER TABLE ${tx(t)} ENABLE TRIGGER ${tx(trigger)}`;
    }
  });
}

async function say(b: Bot, g: string, body = "a question for the lead") {
  const r = await call(sendRoute, {
    key: b.key,
    body: { channel: g, body },
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
}

const read = async (b: Bot, id: string) => {
  const r = await call(readRoute, { key: b.key, params: { id } });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};

const session = (b: Bot, g: string) =>
  call(eventsRoute, {
    key: b.key,
    path: "/v1/events",
    body: { action: "session", channel: g, in_minutes: 30 },
  });

const wake = async (b: Bot): Promise<number> =>
  (await call(wakeRoute, { key: b.key })).body.wake;

const acting = async (id: string) => {
  const [r] = await db()<{ h: string | null }[]>`
    SELECT (SELECT handle FROM bots WHERE id = channel_acting_lead(${id})) AS h`;
  return r?.h ?? null;
};

// Members wait on lea: ben twice and cy once, all aged past the threshold.
async function waiting(c: Awaited<ReturnType<typeof three>>) {
  await say(c.ben, c.g);
  await say(c.cy, c.g);
  await say(c.ben, c.g);
  await age(LEAD_QUIET_AFTER_HOURS + 1);
}

describe("an acting lead", () => {
  it("holds the public numbers to the SQL", async () => {
    const [r] = await db()<{ n: number; h: number }[]>`
      SELECT lead_quiet_waiting() AS n,
             extract(epoch FROM lead_quiet_after())::int / 3600 AS h`;
    expect(r).toEqual({ n: LEAD_QUIET_WAITING, h: LEAD_QUIET_AFTER_HOURS });
  });

  it("is the longest-standing member taking part while the leader is quiet", async () => {
    const c = await three();
    await waiting(c);
    expect(await acting(c.id)).toBe("ben");
    const asBen = await read(c.ben, c.id);
    expect(asBen.you).toMatchObject({
      lead: false,
      acting: true,
      acting_note: ACTING_LEAD_YOU_NOTE,
    });
    expect(asBen.channel).toMatchObject({
      leader: "lea",
      acting_lead: "ben",
      acting_lead_note: actingLeadNote("ben"),
    });
    const asCy = await read(c.cy, c.id);
    expect(asCy.you.acting).toBeUndefined();
    expect(asCy.channel.acting_lead).toBe("ben");
    expect(actingLeadNote("ben")).toBe(
      "Acting lead: @ben. Send session decisions here.",
    );
    // Nothing says the leader stopped answering, or for how long.
    expect(JSON.stringify(asCy)).not.toMatch(/quiet|stopped|away|hours/i);
    const groups = await myGroups(db(), c.ben.id);
    expect(groups[0]).toMatchObject({
      leader: "lea",
      you_lead: false,
      acting_lead: "ben",
      you_act: true,
    });
    const cys = await myGroups(db(), c.cy.id);
    expect(cys[0]?.acting_lead).toBe("ben");
    expect(cys[0]?.you_act).toBeUndefined();
  });

  it("isn't there with too few waiting messages, or too fresh ones", async () => {
    const c = await three();
    await say(c.ben, c.g);
    await say(c.cy, c.g);
    await age(LEAD_QUIET_AFTER_HOURS + 1);
    expect(await acting(c.id)).toBeNull();
    // A third, but only just written: the first is old, so now it counts.
    await say(c.ben, c.g);
    expect(await acting(c.id)).toBe("ben");
    // In a fresh group, three new ones aren't enough.
    await resetDb();
    const d = await three();
    await say(d.ben, d.g);
    await say(d.cy, d.g);
    await say(d.ben, d.g);
    expect(await acting(d.id)).toBeNull();
    const r = await read(d.ben, d.id);
    expect(r.channel.acting_lead).toBeUndefined();
    expect(r.you.acting).toBeUndefined();
    expect((await myGroups(db(), d.ben.id))[0]).not.toHaveProperty(
      "acting_lead",
    );
  });

  it("goes back the moment the leader acts", async () => {
    const c = await three();
    await waiting(c);
    expect(await acting(c.id)).toBe("ben");
    await say(c.lea, c.g, "here, reading back");
    expect(await acting(c.id)).toBeNull();
    const r = await session(c.ben, c.g);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("not_leader");
  });

  it("starts the clock again for a member the lead falls to when the leader is frozen", async () => {
    // Fable's review of #221: a freeze makes the lead fall by seniority with
    // no row of its own, so ben, now leader, was measured from its own old
    // message and cyd's waiting messages made cyd acting lead at once.
    const c = await three();
    await say(c.ben, c.g);
    await say(c.cy, c.g);
    await say(c.cy, c.g);
    await say(c.cy, c.g);
    await age(LEAD_QUIET_AFTER_HOURS + 1);
    expect(await acting(c.id)).toBe("ben");
    await setFrozen(db(), "lea", true, "test");
    expect((await read(c.ben, c.id)).channel.leader).toBe("ben");
    expect(await acting(c.id)).toBeNull();
    expect((await session(c.cy, c.g)).status).toBe(403);
    expect((await session(c.ben, c.g)).status).toBe(200);
    // Unfrozen, lea leads again, and is as quiet as before.
    await setFrozen(db(), "lea", false, "test");
    expect(await acting(c.id)).toBe("ben");
  });

  it("counts the leader's removal of a frozen member as acting", async () => {
    // Fable's review of #221: the removal was judged by the removed bot,
    // never by who removed it.
    const c = await three();
    await say(c.ben, c.g);
    await say(c.ben, c.g);
    await say(c.ben, c.g);
    await say(c.cy, c.g);
    await age(LEAD_QUIET_AFTER_HOURS + 1);
    await setFrozen(db(), "cyd", true, "test");
    expect(await acting(c.id)).toBe("ben");
    const r = await call(removeRoute, {
      key: c.lea.key,
      params: { id: c.id },
      body: { handle: "cyd" },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await acting(c.id)).toBeNull();
    // Unfreezing the bot it took out doesn't move when lea last acted.
    await setFrozen(db(), "cyd", false, "test");
    expect(await acting(c.id)).toBeNull();
  });

  it("starts the clock again when a named leader junior to the next is frozen", async () => {
    // Fable's re-review of #221: cyd, named leader but the newest member,
    // is frozen, so the lead falls to lea by seniority with no row of its
    // own; lea mustn't be measured from its old join.
    await bot("lea");
    const ben = await bot("ben");
    const cyd = await bot("cyd");
    const [h] = await db()<{ id: string }[]>`
      INSERT INTO humans (auth_user_id) VALUES ('google-q') RETURNING id`;
    await db()`UPDATE bots SET owner_id = ${Number(h?.id)}`;
    for (const x of ["lea", "ben", "cyd"]) await ageLink(x);
    const { channel } = await startChannel(
      db(),
      "google-q",
      ["lea", "ben", "cyd"],
      "cyd",
      null,
    );
    const id = channel.replace("private:", "");
    await say(ben, channel);
    await say(ben, channel);
    await say(ben, channel);
    await age(LEAD_QUIET_AFTER_HOURS + 1);
    await say(cyd, channel, "here");
    expect(await acting(id)).toBeNull();
    await setFrozen(db(), "cyd", true, "test");
    expect((await read(ben, id)).channel.leader).toBe("lea");
    expect(await acting(id)).toBeNull();
    expect((await session(ben, channel)).status).toBe(403);
  });

  it("isn't ended by a junior member leaving", async () => {
    // Fable's re-review of #221: any member's leaving counted as the
    // leader acting, so anyone could end an acting lead by leaving.
    const c = await three();
    await waiting(c);
    expect(await acting(c.id)).toBe("ben");
    const r = await call(leaveRoute, { key: c.cy.key, params: { id: c.id } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await acting(c.id)).toBe("ben");
  });

  it("isn't ended by a senior member leaving or frozen while the named leader stands", async () => {
    // Fable's third review of #221: with cyd, the newest member, named
    // leader, ben (senior to cyd, taking no part) leaving or being frozen
    // counted as cyd acting, though nobody's leaving hands a named leader
    // anything.
    const lea = await bot("lea");
    const ben = await bot("ben");
    await bot("cyd");
    const [h] = await db()<{ id: string }[]>`
      INSERT INTO humans (auth_user_id) VALUES ('google-r') RETURNING id`;
    await db()`UPDATE bots SET owner_id = ${Number(h?.id)}`;
    for (const x of ["lea", "ben", "cyd"]) await ageLink(x);
    const { channel } = await startChannel(
      db(),
      "google-r",
      ["lea", "ben", "cyd"],
      "cyd",
      null,
    );
    const id = channel.replace("private:", "");
    await say(lea, channel);
    await say(lea, channel);
    await say(lea, channel);
    await age(LEAD_QUIET_AFTER_HOURS + 1);
    expect(await acting(id)).toBe("lea");
    await setFrozen(db(), "ben", true, "test");
    expect(await acting(id)).toBe("lea");
    await setFrozen(db(), "ben", false, "test");
    expect(await acting(id)).toBe("lea");
    const r = await call(leaveRoute, { key: ben.key, params: { id } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await acting(id)).toBe("lea");
  });

  it("isn't moved by freezing a former leader that left the group", async () => {
    // Fable's third review of #221: the named leader's freeze counted after
    // it had left, so freezing a bot outside the group ended cyd's acting
    // lead, and unfreezing it brought it back.
    const c = await three();
    const r = await call(leaveRoute, { key: c.lea.key, params: { id: c.id } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await read(c.ben, c.id)).channel.leader).toBe("ben");
    await say(c.cy, c.g);
    await say(c.cy, c.g);
    await say(c.cy, c.g);
    await age(LEAD_QUIET_AFTER_HOURS + 1);
    expect(await acting(c.id)).toBe("cyd");
    await setFrozen(db(), "lea", true, "test");
    expect(await acting(c.id)).toBe("cyd");
    await setFrozen(db(), "lea", false, "test");
    expect(await acting(c.id)).toBe("cyd");
  });

  it("still counts a named leader's freeze once it's taken out frozen", async () => {
    // A freeze while in the group hands the lead on; taking the frozen bot
    // out afterwards mustn't take that back and start ben's clock earlier.
    const c = await three();
    await say(c.ben, c.g);
    await say(c.cy, c.g);
    await say(c.cy, c.g);
    await say(c.cy, c.g);
    await age(LEAD_QUIET_AFTER_HOURS + 1);
    await setFrozen(db(), "lea", true, "test");
    expect(await acting(c.id)).toBeNull();
    await setOwnBots(db(), "google-p", c.g, [], ["lea"], null);
    expect(await acting(c.id)).toBeNull();
  });

  it("skips a frozen or silent member, and never tells silence apart", async () => {
    const c = await three();
    // A frozen member's messages don't wait on anyone, so cyd's three do.
    await say(c.ben, c.g);
    for (let i = 0; i < 3; i++) await say(c.cy, c.g);
    await age(LEAD_QUIET_AFTER_HOURS + 1);
    expect(await acting(c.id)).toBe("ben");
    await setFrozen(db(), "ben", true, "test");
    expect(await acting(c.id)).toBe("cyd");
    await setFrozen(db(), "ben", false, "test");
    expect(await acting(c.id)).toBe("ben");
    // A silenced acting lead stays it, so no member learns of the silence,
    // and is refused a session as a silenced leader is.
    await db()`UPDATE bots SET silenced_until = now() + interval '1 hour' WHERE id = ${c.ben.id}`;
    expect(await acting(c.id)).toBe("ben");
    const r = await session(c.ben, c.g);
    expect(r.status).toBe(403);
    expect(r.body.error.code).not.toBe("not_leader");
    // Only cy wrote: ben, silent, isn't picked though it stands longer.
    await resetDb();
    const d = await three();
    await say(d.cy, d.g);
    await say(d.cy, d.g);
    await say(d.cy, d.g);
    await age(LEAD_QUIET_AFTER_HOURS + 1);
    expect(await acting(d.id)).toBe("cyd");
  });

  it("may set and end the session, and nothing else the leader does", async () => {
    const c = await three();
    await waiting(c);
    const set = await session(c.ben, c.g);
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect((await session(c.cy, c.g)).body.error.code).toBe("not_leader");
    const ended = await call(eventsRoute, {
      key: c.ben.key,
      path: "/v1/events",
      body: { action: "end", channel: c.g },
    });
    expect(ended.status, JSON.stringify(ended.body)).toBe(200);
    const removed = await call(removeRoute, {
      key: c.ben.key,
      params: { id: c.id },
      body: { handle: "cyd" },
    });
    expect(removed.status).toBe(403);
    expect(removed.body.error.code).toBe("not_leader");
    const closed = await call(closeRoute, {
      key: c.ben.key,
      params: { id: c.id },
    });
    expect(closed.status).toBe(403);
    expect(closed.body.error.code).toBe("not_leader");
  });

  it("counts a person's call, and a sender the leader blocked", async () => {
    const c = await three();
    await say(c.ben, c.g);
    await say(c.cy, c.g);
    const sent = await postAsPerson(db(), {
      authUserId: "google-p",
      channel: c.g,
      body: "please pick this up",
      wake: "leader",
      leader: "lea",
      nonce: "nonce-acting-000001",
      ipHash: null,
    });
    // It still wakes the leader alone: the page names no one else.
    expect(sent.woke).toBe(1);
    await age(LEAD_QUIET_AFTER_HOURS + 1);
    expect(await acting(c.id)).toBe("ben");
    // lea blocks ben: the acting lead doesn't move, so no member learns of it.
    const blocked = await call(blockRoute, {
      key: c.lea.key,
      params: { handle: "ben" },
    });
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(200);
    expect(await acting(c.id)).toBe("ben");
    expect((await read(c.cy, c.id)).channel.acting_lead).toBe("ben");
  });

  it("lets a former acting lead end its own session, and set no other", async () => {
    const c = await three();
    await waiting(c);
    expect((await session(c.ben, c.g)).status).toBe(200);
    const inv = await call(invitesRoute, {
      key: c.ben.key,
      params: { id: c.id },
      body: { for: "lea" },
    });
    expect(inv.status).toBe(403);
    expect(inv.body.error.code).toBe("not_leader");
    await say(c.lea, c.g, "back");
    expect((await session(c.ben, c.g)).body.error.code).toBe("not_leader");
    const ended = await call(eventsRoute, {
      key: c.ben.key,
      path: "/v1/events",
      body: { action: "end", channel: c.g },
    });
    expect(ended.status, JSON.stringify(ended.body)).toBe(200);
  });

  it("is none in a closed group", async () => {
    const c = await three();
    await waiting(c);
    const closed = await call(closeRoute, {
      key: c.lea.key,
      params: { id: c.id },
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(await acting(c.id)).toBeNull();
  });
});
