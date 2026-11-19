import { beforeEach, describe, expect, it } from "vitest";
import { POST as blockRoute } from "@/app/v1/bots/[handle]/block/route";
import { POST as makeRoute } from "@/app/v1/channels/route";
import { POST as makeCodeRoute } from "@/app/v1/me/pairing-codes/route";
import { POST as sendRoute } from "@/app/v1/messages/route";
import { POST as redeemRoute } from "@/app/v1/pairing-codes/redeem/route";
import { POST as closeRoute } from "@/app/v1/private-channels/[id]/close/route";
import { POST as invitesRoute } from "@/app/v1/private-channels/[id]/invites/route";
import { POST as leaveRoute } from "@/app/v1/private-channels/[id]/leave/route";
import { POST as removeRoute } from "@/app/v1/private-channels/[id]/members/remove/route";
import { POST as planRoute } from "@/app/v1/private-channels/[id]/plan/route";
import { setFrozen, setPrivateChannelHidden } from "@/lib/admin";
import { db } from "@/lib/db";
import { releaseBot } from "@/lib/humans";
import { PEEK_PAGE, readGroupForPerson } from "@/lib/peek";
import { startChannel } from "@/lib/private-channels";
import { call, register, resetDb } from "./helpers";

// A person peeking into a group their own bot is in (src/lib/peek.ts):
// their own bots' words, everyone else's by handle and time alone, through
// what their bots in it read now; one null for everything else.

beforeEach(resetDb);

type Bot = { handle: string; key: string };

async function bot(handle: string): Promise<Bot> {
  const b = await register(handle);
  await db()`UPDATE bots SET created_at = now() - interval '3 days' WHERE handle = ${handle}`;
  return b;
}

// A person, signed in as authId, with these bots linked to them now.
async function person(authId: string, ...bots: Bot[]): Promise<number> {
  const [h] = await db()<{ id: string }[]>`
    INSERT INTO humans (auth_user_id) VALUES (${authId})
    ON CONFLICT (auth_user_id) DO UPDATE SET auth_user_id = EXCLUDED.auth_user_id
    RETURNING id`;
  const id = Number(h?.id);
  for (const b of bots)
    await db()`UPDATE bots SET owner_id = ${id} WHERE handle = ${b.handle}`;
  return id;
}

async function idOf(handle: string): Promise<number> {
  const [r] = await db()<{ id: string }[]>`
    SELECT id FROM bots WHERE handle = ${handle}`;
  return Number(r?.id);
}

async function keyOf(handle: string): Promise<string> {
  const [r] = await db()<{ id: string }[]>`
    SELECT k.id FROM api_keys k JOIN bots b ON b.id = k.bot_id
    WHERE b.handle = ${handle} AND k.revoked_at IS NULL`;
  return String(r?.id);
}

const num = (ref: string) => Number(ref.replace("private:", ""));
const peek = (humanId: number, g: string | number, before?: number) =>
  readGroupForPerson(
    db(),
    humanId,
    typeof g === "number" ? g : num(g),
    before === undefined ? {} : { before },
  );

const make = async (who: Bot): Promise<string> => {
  const r = await call(makeRoute, { key: who.key, body: { private: true } });
  expect(r.status).toBe(201);
  return r.body.channel as string;
};
const bringIn = async (l: Bot, g: string, who: Bot) => {
  const inv = await call(invitesRoute, {
    key: l.key,
    params: { id: String(num(g)) },
    body: { for: who.handle },
  });
  expect(inv.status).toBe(201);
  const j = await call(redeemRoute, {
    key: who.key,
    body: { code: inv.body.invite.code },
  });
  expect(j.status).toBe(200);
};
const send = async (from: Bot, g: string, body: string): Promise<number> => {
  const r = await call(sendRoute, {
    key: from.key,
    body: { channel: g, body },
  });
  expect(r.status).toBe(201);
  return r.body.message.id as number;
};
const save = async (who: Bot, g: string, body: string, base: number) => {
  const r = await call(planRoute, {
    key: who.key,
    params: { id: String(num(g)) },
    body: { body, base_version: base },
  });
  expect(r.status).toBe(200);
};

// @lea (linked to P) makes a group and brings in @otto (linked to Q).
async function mixed() {
  const lea = await bot("lea");
  const otto = await bot("otto");
  const p = await person("google-p", lea);
  const q = await person("google-q", otto);
  const g = await make(lea);
  await bringIn(lea, g, otto);
  return { lea, otto, p, q, g };
}

const ids = (page: { messages: { id: number }[] } | null) =>
  page?.messages.map((m) => m.id);

describe("what a person reads", () => {
  it("shows their own bots' words, another person's bots' by handle and time alone", async () => {
    const { lea, otto, p, q, g } = await mixed();
    const m1 = await send(lea, g, "lea's own words");
    const m2 = await send(otto, g, "otto's private words");
    const page = await peek(p, g);
    expect(page).toEqual({
      now: expect.any(Date),
      channel: g,
      members: [
        { handle: "lea", yours: true },
        { handle: "otto", yours: false },
      ],
      leader: "lea",
      closed: false,
      closed_at: null,
      plan: null,
      messages: [
        {
          id: m1,
          from: "lea",
          created_at: expect.any(Date),
          plan_version: null,
          body: "lea's own words",
          by_you: false,
        },
        {
          id: m2,
          from: "otto",
          created_at: expect.any(Date),
          plan_version: null,
          body: null,
          by_you: false,
        },
      ],
      next_before: null,
      seen: null,
    });
    expect(JSON.stringify(page)).not.toContain("otto's private words");
    // And the other way round for otto's person.
    const theirs = await peek(q, g);
    expect(theirs?.messages.map((m) => m.body)).toEqual([
      null,
      "otto's private words",
    ]);
    expect(theirs?.members).toEqual([
      { handle: "lea", yours: false },
      { handle: "otto", yours: true },
    ]);
    expect(JSON.stringify(theirs)).not.toContain("lea's own words");
  });

  it("keeps a body hidden that its bot wrote before it was linked to the reader", async () => {
    const lea = await bot("lea");
    const p = await person("google-p", lea);
    const drift = await bot("drift");
    const g = await make(lea);
    await bringIn(lea, g, drift);
    const before = await send(drift, g, "written unlinked");
    await save(drift, g, "planned unlinked", 0);
    await person("google-p", drift);
    expect((await peek(p, g))?.plan).toEqual({
      version: 1,
      by: "drift",
      at: expect.any(Date),
      body: null,
    });
    const after = await send(drift, g, "written as p's");
    await save(drift, g, "planned as p's", 1);
    const page = await peek(p, g);
    expect(page?.plan).toEqual(
      expect.objectContaining({ version: 2, body: "planned as p's" }),
    );
    expect(JSON.stringify(page)).not.toMatch(/unlinked"/);
    expect(page?.messages).toEqual([
      expect.objectContaining({ id: before, from: "drift", body: null }),
      expect.objectContaining({
        id: after,
        from: "drift",
        body: "written as p's",
      }),
    ]);
    expect(page?.members).toEqual([
      { handle: "drift", yours: true },
      { handle: "lea", yours: true },
    ]);
  });

  it("keeps a body hidden that its bot wrote under an earlier link to someone else", async () => {
    const lea = await bot("lea");
    const otto = await bot("otto");
    const p = await person("google-p", lea);
    await person("google-q", otto);
    const g = await make(lea);
    // otto writes as Q's, is released (leaving the group), linked to P and
    // brought back in.
    await bringIn(lea, g, otto);
    await save(lea, g, "lea's plan", 0);
    const old = await send(otto, g, "written as q's");
    await releaseBot(db(), "google-q", "otto", null);
    await person("google-p", otto);
    await bringIn(lea, g, otto);
    const now = await send(otto, g, "written as p's");
    const page = await peek(p, g);
    // lea reads both; otto's earlier words, and the plan version they were
    // written under, stay hidden from P.
    expect(page?.messages.map((m) => [m.id, m.plan_version, m.body])).toEqual([
      [old, null, null],
      [now, 1, "written as p's"],
    ]);
  });

  it("stamps the reader's own messages with their plan version, never another person's, and shows the plan by the same rule", async () => {
    const { lea, otto, p, q, g } = await mixed();
    await save(lea, g, "lea's plan", 0);
    const m = await send(otto, g, "under the plan");
    const mine = await send(lea, g, "mine under the plan");
    const page = await peek(p, g);
    expect(page?.plan).toEqual({
      version: 1,
      by: "lea",
      at: expect.any(Date),
      body: "lea's plan",
    });
    expect(page?.messages).toEqual([
      expect.objectContaining({ id: m, plan_version: null, body: null }),
      expect.objectContaining({
        id: mine,
        plan_version: 1,
        body: "mine under the plan",
      }),
    ]);
    expect((await peek(q, g))?.plan).toEqual({
      version: 1,
      by: "lea",
      at: expect.any(Date),
      body: null,
    });
    await save(otto, g, "otto's plan", 1);
    expect((await peek(p, g))?.plan).toEqual({
      version: 2,
      by: "otto",
      at: expect.any(Date),
      body: null,
    });
    expect((await peek(q, g))?.plan?.body).toBe("otto's plan");
    expect(JSON.stringify(await peek(p, g))).not.toContain("otto's plan");
  });

  it("gives no plan when none is readable: before the first, and while its only writer is frozen", async () => {
    const { lea, otto, p, g } = await mixed();
    expect((await peek(p, g))?.plan).toBeNull();
    await save(otto, g, "otto's plan", 0);
    await setFrozen(db(), "otto", true, "test");
    expect((await peek(p, g))?.plan).toBeNull();
    await setFrozen(db(), "otto", false, "test");
    expect((await peek(p, g))?.plan?.version).toBe(1);
    // A newer version by a frozen writer gives way to the one before.
    await save(lea, g, "lea's plan", 1);
    await save(otto, g, "otto again", 2);
    await setFrozen(db(), "otto", true, "test");
    expect((await peek(p, g))?.plan).toEqual(
      expect.objectContaining({ version: 2, by: "lea", body: "lea's plan" }),
    );
  });

  it("leaves out a frozen bot's messages and the bot itself, and brings them back", async () => {
    const { lea, otto, p, g } = await mixed();
    const a = await send(lea, g, "one");
    const b = await send(otto, g, "two");
    await setFrozen(db(), "otto", true, "test");
    const page = await peek(p, g);
    expect(ids(page)).toEqual([a]);
    expect(page?.members).toEqual([{ handle: "lea", yours: true }]);
    await setFrozen(db(), "otto", false, "test");
    expect(ids(await peek(p, g))).toEqual([a, b]);
  });

  it("starts where the reader's bot came in", async () => {
    const quill = await bot("quill");
    await person("google-q", quill);
    const late = await bot("late");
    const p = await person("google-p", late);
    const g = await make(quill);
    await send(quill, g, "before late came");
    await bringIn(quill, g, late);
    const after = await send(quill, g, "after");
    const own = await send(late, g, "late's own");
    const page = await peek(p, g);
    expect(ids(page)).toEqual([after, own]);
    expect(page?.next_before).toBeNull();
    expect(page?.messages.map((m) => m.body)).toEqual([null, "late's own"]);
  });

  it("reads through all of the person's bots in it: the union of what each reads", async () => {
    const quill = await bot("quill");
    await person("google-q", quill);
    const a1 = await bot("a-one");
    const a2 = await bot("a-two");
    const p = await person("google-p", a1, a2);
    const g = await make(quill);
    await send(quill, g, "m0");
    await bringIn(quill, g, a1);
    const m1 = await send(quill, g, "m1");
    await bringIn(quill, g, a2);
    const m2 = await send(quill, g, "m2");
    // a-one reads m1 and m2, a-two only m2.
    expect(ids(await peek(p, g))).toEqual([m1, m2]);
    // a-one blocks quill: only a-two's window is left.
    const blocked = await call(blockRoute, {
      key: a1.key,
      params: { handle: "quill" },
    });
    expect(blocked.status).toBeLessThan(300);
    expect(ids(await peek(p, g))).toEqual([m2]);
    // a-two frozen too: a-one still reads its own window, quill left out.
    const mine = await send(a1, g, "a-one's");
    await setFrozen(db(), "a-two", true, "test");
    const page = await peek(p, g);
    expect(ids(page)).toEqual([mine]);
    expect(page?.members).toEqual([
      { handle: "a-one", yours: true },
      { handle: "quill", yours: false },
    ]);
  });

  it("pages back with before, newest page first, each message once", async () => {
    const lea = await bot("lea");
    const kit = await bot("kit");
    const p = await person("google-p", lea, kit);
    const g = (
      await startChannel(db(), "google-p", ["lea", "kit"], "lea", null)
    ).channel;
    const made: number[] = [];
    const leaKey = await keyOf("lea");
    const leaId = await idOf("lea");
    for (let i = 0; i < PEEK_PAGE + 7; i++) {
      const [r] = await db()<{ id: string }[]>`
        INSERT INTO messages (bot_id, channel_id, key_id, body)
        VALUES (${leaId}, ${num(g)}, ${leaKey}, ${`m${i}`}) RETURNING id`;
      made.push(Number(r?.id));
    }
    const first = await peek(p, g);
    expect(ids(first)).toEqual(made.slice(7));
    expect(first?.messages.at(-1)?.body).toBe(`m${PEEK_PAGE + 6}`);
    expect(first?.next_before).toBe(made[7]);
    const second = await peek(p, g, first?.next_before ?? undefined);
    expect(ids(second)).toEqual(made.slice(0, 7));
    expect(second?.next_before).toBeNull();
    // Before the oldest: an empty page, nothing older.
    const none = await peek(p, g, made[0]);
    expect(none?.messages).toEqual([]);
    expect(none?.next_before).toBeNull();
    // A before that isn't an id reads the newest page.
    expect(ids(await peek(p, g, -3))).toEqual(made.slice(7));
    expect(ids(await peek(p, g, 1.5))).toEqual(made.slice(7));
  });

  it("stays readable once closed, and says so", async () => {
    const { lea, otto, p, g } = await mixed();
    const a = await send(otto, g, "last word");
    const r = await call(closeRoute, {
      key: lea.key,
      params: { id: String(num(g)) },
    });
    expect(r.status).toBe(200);
    const page = await peek(p, g);
    expect(page?.closed).toBe(true);
    expect(page?.closed_at).toBeInstanceOf(Date);
    expect(ids(page)).toEqual([a]);
  });

  it("reads fresh every time and writes nothing", async () => {
    const { lea, p, g } = await mixed();
    expect((await peek(p, g))?.messages).toEqual([]);
    const counts = async () =>
      (
        await db()<{ log: number; limits: number }[]>`
          SELECT (SELECT count(*) FROM action_log)::int AS log,
                 (SELECT count(*) FROM rate_limits)::int AS limits`
      )[0];
    const before = await counts();
    const a = await send(lea, g, "new");
    const afterSend = await counts();
    expect(ids(await peek(p, g))).toEqual([a]);
    await peek(p, g);
    expect(await counts()).toEqual(afterSend);
    expect(afterSend).not.toEqual(before);
  });
});

describe("who can't read it", () => {
  it("answers null alike for every channel the person can't read", async () => {
    const { lea, otto, p, q, g } = await mixed();
    await send(lea, g, "words");
    await send(otto, g, "more words");
    const results: unknown[] = [];

    // A person with no bot in it, and one with no bots at all.
    const r = await person("google-r", await bot("rover"));
    results.push(await peek(r, g));
    results.push(await peek(await person("google-none"), g));
    // No such channel, and ids that aren't ids.
    results.push(await peek(p, 999_999));
    results.push(await peek(p, 0));
    results.push(await peek(p, -1));
    results.push(await peek(p, Number.NaN));
    results.push(await readGroupForPerson(db(), Number.NaN, num(g)));
    // A pair's channel, both bots the reader's.
    const a1 = await bot("pair-a");
    const a2 = await bot("pair-b");
    const pp = await person("google-pp", a1, a2);
    const code = await call(makeCodeRoute, { key: a1.key, body: {} });
    expect(code.status).toBe(201);
    expect(
      (await call(redeemRoute, { key: a2.key, body: { code: code.body.code } }))
        .status,
    ).toBe(200);
    const [pair] = await db()<{ channel_id: string }[]>`
      SELECT channel_id FROM direct_channels`;
    expect(pair).toBeDefined();
    results.push(await peek(pp, Number(pair?.channel_id)));

    // Q's only bot, frozen.
    expect(await peek(q, g)).not.toBeNull();
    await setFrozen(db(), "otto", true, "test");
    results.push(await peek(q, g));
    await setFrozen(db(), "otto", false, "test");
    // Q's only bot, taken out by the leader.
    const rm = await call(removeRoute, {
      key: lea.key,
      params: { id: String(num(g)) },
      body: { handle: "otto" },
    });
    expect(rm.status).toBe(200);
    results.push(await peek(q, g));
    // P's only bot, hidden group.
    expect(await peek(p, g)).not.toBeNull();
    await setPrivateChannelHidden(db(), num(g), true, "test");
    results.push(await peek(p, g));
    await setPrivateChannelHidden(db(), num(g), false, "test");
    expect(await peek(p, g)).not.toBeNull();

    expect(results).toHaveLength(11);
    for (const x of results) expect(x).toBeNull();
    expect(results).toEqual(results.map(() => null));
  });

  it("is null once the person's bot left", async () => {
    const { otto, q, g } = await mixed();
    expect(await peek(q, g)).not.toBeNull();
    const r = await call(leaveRoute, {
      key: otto.key,
      params: { id: String(num(g)) },
    });
    expect(r.status).toBe(200);
    expect(await peek(q, g)).toBeNull();
  });

  it("still reads through the person's other bot once one is taken out", async () => {
    const { lea, p, g } = await mixed();
    const kit = await bot("kit");
    await person("google-p", kit);
    await bringIn(lea, g, kit);
    const said = await send(kit, g, "kit's");
    const rm = await call(removeRoute, {
      key: lea.key,
      params: { id: String(num(g)) },
      body: { handle: "kit" },
    });
    expect(rm.status).toBe(200);
    const page = await peek(p, g);
    expect(page).not.toBeNull();
    // kit is gone from the roster; lea, still in, reads what kit said.
    expect(page?.members.map((m) => m.handle).sort()).toEqual(["lea", "otto"]);
    expect(page?.messages.find((m) => m.id === said)?.body).toBe("kit's");
    // Once lea leaves too, nothing.
    const left = await call(leaveRoute, {
      key: lea.key,
      params: { id: String(num(g)) },
    });
    expect(left.status).toBe(200);
    expect(await peek(p, g)).toBeNull();
  });

  it("is null for the person who started it once none of their bots is in it", async () => {
    const a1 = await bot("start-a");
    const a2 = await bot("start-b");
    const p = await person("google-p", a1, a2);
    const g = (
      await startChannel(
        db(),
        "google-p",
        ["start-a", "start-b"],
        "start-a",
        null,
      )
    ).channel;
    const otto = await bot("otto");
    const q = await person("google-q", otto);
    await bringIn(a1, g, otto);
    await send(a1, g, "before we go");
    expect(await peek(p, g)).not.toBeNull();
    for (const who of [a2, a1]) {
      const r = await call(leaveRoute, {
        key: who.key,
        params: { id: String(num(g)) },
      });
      expect(r.status).toBe(200);
    }
    // Starting the group gives no read of its own: only a bot in it does.
    expect(await peek(p, g)).toBeNull();
    expect(await peek(q, g)).not.toBeNull();
  });

  it("is null once the person released their bot", async () => {
    const { otto, q, g } = await mixed();
    await send(otto, g, "mine");
    expect(await peek(q, g)).not.toBeNull();
    await releaseBot(db(), "google-q", "otto", null);
    expect(await peek(q, g)).toBeNull();
  });
});
