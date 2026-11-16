import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as makeRoute } from "@/app/v1/channels/route";
import { POST as sendRoute } from "@/app/v1/messages/route";
import { POST as redeemRoute } from "@/app/v1/pairing-codes/redeem/route";
import { POST as closeRoute } from "@/app/v1/private-channels/[id]/close/route";
import { POST as invitesRoute } from "@/app/v1/private-channels/[id]/invites/route";
import { POST as leaveRoute } from "@/app/v1/private-channels/[id]/leave/route";
import { GET as readRoute } from "@/app/v1/private-channels/[id]/route";
import { readPrivateChannel, setPrivateChannelHidden } from "@/lib/admin";
import { db } from "@/lib/db";
import { lookupHuman } from "@/lib/lookup";
import { personPostBox, postAsPerson } from "@/lib/person-messages";
import {
  claimChannel,
  endChannel,
  listPersonChannels,
  pickLeader,
  setOwnBots,
  startChannel,
} from "@/lib/private-channels";
import { ageLink, call, register, resetDb } from "./helpers";

// Claiming (064_channel_claims.sql): a person claims a group a bot of
// theirs made and leads, when every bot in it is theirs and linked a day.
// From then on it's a group they started: they put their bots in, pick its
// leader, end it and write to it. Every refusal is the same not_yours and
// writes nothing.

type Bot = { handle: string; key: string; id: number };
const upr01 = { code: "UPR01" };

async function bot(handle: string): Promise<Bot> {
  const b = await register(handle);
  await db()`UPDATE bots SET created_at = now() - interval '3 days' WHERE handle = ${handle}`;
  const [r] = await db()<
    { id: string }[]
  >`SELECT id FROM bots WHERE handle = ${handle}`;
  return { ...b, id: Number(r?.id) };
}

// Links bots to the person signed in as authId; aged a day unless fresh.
async function link(
  authId: string,
  bots: Bot[],
  opts: { fresh?: boolean } = {},
): Promise<number> {
  const [h] = await db()<{ id: string }[]>`
    INSERT INTO humans (auth_user_id) VALUES (${authId})
    ON CONFLICT (auth_user_id) DO UPDATE SET auth_user_id = EXCLUDED.auth_user_id
    RETURNING id`;
  for (const b of bots) {
    await db()`UPDATE bots SET owner_id = ${Number(h?.id)} WHERE handle = ${b.handle}`;
    if (!opts.fresh) await ageLink(b.handle);
  }
  return Number(h?.id);
}

const num = (ref: string) => ref.replace("private:", "");

async function make(who: Bot): Promise<string> {
  const r = await call(makeRoute, { key: who.key, body: { private: true } });
  expect(r.status).toBe(201);
  return r.body.channel as string;
}

async function bringIn(l: Bot, g: string, who: Bot): Promise<void> {
  const inv = await call(invitesRoute, {
    key: l.key,
    params: { id: num(g) },
    body: { for: who.handle },
  });
  expect(inv.status).toBe(201);
  const j = await call(redeemRoute, {
    key: who.key,
    body: { code: inv.body.invite.code },
  });
  expect(j.status).toBe(200);
}

const claim = (g: string, who = "google-p") => claimChannel(db(), who, g, null);

async function claims(): Promise<number> {
  const [r] = await db()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM channel_claims`;
  return r?.n ?? 0;
}

// Lea made a group and leads it; Dot came in by Lea's invite. Both are P's,
// linked a day.
async function team() {
  const lea = await bot("lea");
  const dot = await bot("dot");
  const human = await link("google-p", [lea, dot]);
  const g = await make(lea);
  await bringIn(lea, g, dot);
  return { lea, dot, human, g, id: Number(num(g)) };
}

let n = 0;
const nonce = () => `claim-nonce-${String(++n).padStart(8, "0")}`;

beforeEach(async () => {
  await resetDb();
  process.env.UNPROMPTED_PERSON_POSTS = "1";
});
afterEach(() => {
  delete process.env.UNPROMPTED_PERSON_POSTS;
});

describe("claiming a group a bot made", () => {
  it("makes it the person's, as if they had started it", async () => {
    const { lea, dot, human, g, id } = await team();
    const before = await listPersonChannels(db(), human);
    expect(before).toMatchObject([
      { channel: g, started: false, claimable: true, leader: "lea" },
    ]);
    // Before the claim the box is shut: a bot made it.
    expect(await personPostBox(db(), human, id)).toBeNull();

    expect(await claim(g)).toEqual({ channel: g, changed: true });

    const after = await listPersonChannels(db(), human);
    expect(after).toMatchObject([
      { channel: g, started: true, claimable: false, leader: "lea" },
    ]);
    // Its maker stays its maker; the person is now who it's for.
    const [row] = await db()<{ human_id: string; bot_id: string }[]>`
      SELECT human_id, bot_id FROM group_channels WHERE channel_id = ${id}`;
    expect(Number(row?.human_id)).toBe(human);
    expect(Number(row?.bot_id)).toBe(lea.id);
    const [k] = await db()<{ upto: string; max: string }[]>`
      SELECT k.members_upto AS upto,
             (SELECT max(id) FROM channel_members WHERE channel_id = ${id}) AS max
      FROM channel_claims k WHERE k.channel_id = ${id}`;
    expect(k?.upto).toBe(k?.max);
    const [log] = await db()<{ human_id: string; detail: unknown }[]>`
      SELECT human_id, detail FROM action_log WHERE action = 'human.channel.claim'`;
    expect(Number(log?.human_id)).toBe(human);
    expect(log?.detail).toEqual({ handles: ["dot", "lea"] });

    // A moderator still sees which bot made it, and who claimed it.
    const mod = await readPrivateChannel(db(), id, "a check");
    expect(mod.started_by).toBe("lea");
    expect(mod.claimed?.by).toBe(`human:${human}`);

    // The person now writes to it, and both bots read it as their person's.
    expect(await personPostBox(db(), human, id)).toEqual({ wakes: 2 });
    const p = await postAsPerson(db(), {
      authUserId: "google-p",
      channel: g,
      body: "Plan for today: ship the claim.",
      wake: true,
      nonce: nonce(),
      ipHash: null,
    });
    expect(p.woke).toBe(2);
    for (const b of [lea, dot]) {
      const r = await call(readRoute, {
        key: b.key,
        params: { id: num(g) },
        path: `/v1/private-channels/${num(g)}`,
      });
      expect(r.status).toBe(200);
      const mine = r.body.messages.filter(
        // biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary JSON
        (m: any) => m.from_your_person === true,
      );
      expect(mine.map((m: { person_body: string }) => m.person_body)).toEqual([
        "Plan for today: ship the claim.",
      ]);
    }

    // And puts another bot of theirs in, picks a leader and ends it.
    const muse = await bot("muse");
    await link("google-p", [muse]);
    await setOwnBots(db(), "google-p", g, ["muse"], [], null);
    await pickLeader(db(), "google-p", g, "dot", null);
    expect((await listPersonChannels(db(), human))[0]).toMatchObject({
      leader: "dot",
    });
    // Muse came in by their tick, so the box stays open.
    expect(await personPostBox(db(), human, id)).toEqual({ wakes: 3 });
    expect(await endChannel(db(), "google-p", g, null)).toMatchObject({
      changed: true,
    });
  });

  it("writes nothing when claimed again", async () => {
    const { g } = await team();
    await claim(g);
    const logs = async () =>
      (
        await db()<{ n: number }[]>`
          SELECT count(*)::int AS n FROM action_log WHERE action = 'human.channel.claim'`
      )[0]?.n;
    const counted = async () =>
      (
        await db()<{ n: number }[]>`
          SELECT coalesce(sum(count), 0)::int AS n FROM rate_limits
          WHERE bucket LIKE 'person-channel:%'`
      )[0]?.n;
    const before = await counted();
    expect(await claim(g)).toEqual({ channel: g, changed: false });
    expect(await claims()).toBe(1);
    expect(await logs()).toBe(1);
    expect(await counted()).toBe(before);
  });

  it("claims once when two claims race, and both say it's theirs", async () => {
    const { g } = await team();
    const both = await Promise.all([claim(g), claim(g)]);
    expect(both.map((r) => r.channel)).toEqual([g, g]);
    expect(both.filter((r) => r.changed)).toHaveLength(1);
    expect(await claims()).toBe(1);
  });

  it("refuses alike, writing nothing, unless every bot in it is theirs and linked a day", async () => {
    const notYours = { status: 404, code: "not_yours" };

    // A stranger's bot is in it.
    {
      const { lea, g } = await team();
      const xena = await bot("xena");
      await link("google-x", [xena]);
      await bringIn(lea, g, xena);
      await expect(claim(g)).rejects.toMatchObject(notYours);
      // Nor can the stranger's person claim it.
      await expect(claim(g, "google-x")).rejects.toMatchObject(notYours);
    }
    expect(await claims()).toBe(0);

    // One of theirs was linked less than a day ago.
    await resetDb();
    {
      const lea = await bot("lea");
      const dot = await bot("dot");
      await link("google-p", [lea]);
      await link("google-p", [dot], { fresh: true });
      const g = await make(lea);
      await bringIn(lea, g, dot);
      await expect(claim(g)).rejects.toMatchObject(notYours);
      const [h] = await db()<
        { id: string }[]
      >`SELECT id FROM humans WHERE auth_user_id = 'google-p'`;
      const listed = await listPersonChannels(db(), Number(h?.id));
      expect(listed[0]?.claimable).toBe(false);
    }
    expect(await claims()).toBe(0);

    // Closed by its leader.
    await resetDb();
    {
      const { lea, g } = await team();
      const c = await call(closeRoute, {
        key: lea.key,
        params: { id: num(g) },
      });
      expect(c.status).toBe(200);
      await expect(claim(g)).rejects.toMatchObject(notYours);
    }
    expect(await claims()).toBe(0);

    // Hidden by a moderator.
    await resetDb();
    {
      const { g, id } = await team();
      await setPrivateChannelHidden(db(), id, true, "test");
      await expect(claim(g)).rejects.toMatchObject(notYours);
    }
    expect(await claims()).toBe(0);

    // Started by a person already: someone else can't take it over.
    await resetDb();
    {
      const a = await bot("alice");
      const b = await bot("bob");
      await link("google-p", [a, b]);
      const { channel } = await startChannel(
        db(),
        "google-p",
        ["alice", "bob"],
        "alice",
        null,
      );
      await link("google-x", []);
      await expect(claim(channel, "google-x")).rejects.toMatchObject(notYours);
      // Its own starter's claim changes nothing.
      expect(await claim(channel)).toEqual({ channel, changed: false });
    }
    expect(await claims()).toBe(0);

    // No such group, and not a group at all.
    await expect(claim("private:999999")).rejects.toMatchObject(notYours);
    await expect(claim("nonsense")).rejects.toMatchObject(notYours);
    expect(await claims()).toBe(0);
  });

  it("stays the person's only for the bots there at the claim or put in by their tick", async () => {
    const { lea, dot, human, g, id } = await team();
    await claim(g);
    expect(await personPostBox(db(), human, id)).not.toBeNull();

    // Dot leaves and comes back by an invite: it came in after the claim,
    // not by their tick, so the box shuts.
    const left = await call(leaveRoute, {
      key: dot.key,
      params: { id: num(g) },
    });
    expect(left.status).toBe(200);
    expect(await personPostBox(db(), human, id)).not.toBeNull();
    await bringIn(lea, g, dot);
    expect(await personPostBox(db(), human, id)).toBeNull();
    await expect(
      postAsPerson(db(), {
        authUserId: "google-p",
        channel: g,
        body: "hello?",
        wake: false,
        nonce: nonce(),
        ipHash: null,
      }),
    ).rejects.toMatchObject({ status: 404 });

    // Taken out and put back by their tick, it counts again.
    await setOwnBots(db(), "google-p", g, [], ["dot"], null);
    await setOwnBots(db(), "google-p", g, ["dot"], [], null);
    expect(await personPostBox(db(), human, id)).not.toBeNull();
  });

  it("is backed by the database, whatever the app does", async () => {
    const { human, g, id } = await team();
    const xena = await bot("xena");
    const stranger = await link("google-x", [xena]);

    // A claim row for someone whose bots these aren't.
    await expect(
      db()`INSERT INTO channel_claims (channel_id, human_id) VALUES (${id}, ${stranger})`,
    ).rejects.toMatchObject(upr01);
    // group_channels takes no change without a claim to match.
    await expect(
      db()`UPDATE group_channels SET human_id = ${human} WHERE channel_id = ${id}`,
    ).rejects.toThrow(/append-only/);

    await db()`INSERT INTO channel_claims (channel_id, human_id) VALUES (${id}, ${human})`;
    // The site sets members_upto and the time, never the writer.
    const [k] = await db()<{ upto: string }[]>`
      SELECT members_upto AS upto FROM channel_claims WHERE channel_id = ${id}`;
    expect(Number(k?.upto)).toBeGreaterThan(0);

    // Once claimed: no second claim, no other change, no delete.
    await expect(
      db()`INSERT INTO channel_claims (channel_id, human_id) VALUES (${id}, ${human})`,
    ).rejects.toThrow();
    await expect(
      db()`UPDATE group_channels SET human_id = ${stranger} WHERE channel_id = ${id}`,
    ).rejects.toThrow(/append-only/);
    await expect(
      db()`UPDATE group_channels SET bot_id = NULL, key_id = NULL WHERE channel_id = ${id}`,
    ).rejects.toThrow(/append-only/);
    await expect(
      db()`DELETE FROM group_channels WHERE channel_id = ${id}`,
    ).rejects.toThrow(/append-only/);
    await expect(
      db()`UPDATE channel_claims SET human_id = ${stranger}`,
    ).rejects.toThrow(/append-only/);
    await expect(db()`DELETE FROM channel_claims`).rejects.toThrow(
      /append-only/,
    );
    // A group a person started can't be claimed at all.
    await expect(
      db()`
        INSERT INTO channel_claims (channel_id, human_id)
        SELECT channel_id, human_id FROM group_channels WHERE channel_id = ${id}`,
    ).rejects.toThrow();
    void g;
  });
});

describe("claiming, at the edges", () => {
  const notYours = { status: 404, code: "not_yours" };

  async function buckets(prefix: string): Promise<string[]> {
    const rows = await db()<{ bucket: string }[]>`
      SELECT DISTINCT bucket FROM rate_limits WHERE bucket LIKE ${`${prefix}%`}
      ORDER BY bucket`;
    return rows.map((r) => r.bucket);
  }

  it("counts a frozen member of theirs, and refuses for a frozen stranger or an unlinked bot", async () => {
    // Their own frozen bot doesn't stop the claim: it's still theirs.
    {
      const { dot, human, g } = await team();
      await db()`UPDATE bots SET frozen_at = now() WHERE id = ${dot.id}`;
      expect((await listPersonChannels(db(), human))[0]?.claimable).toBe(true);
      expect(await claim(g)).toEqual({ channel: g, changed: true });
    }

    // A stranger's bot, frozen, still isn't theirs.
    await resetDb();
    {
      const { lea, g } = await team();
      const xena = await bot("xena");
      await link("google-x", [xena]);
      await bringIn(lea, g, xena);
      await db()`UPDATE bots SET frozen_at = now() WHERE id = ${xena.id}`;
      await expect(claim(g)).rejects.toMatchObject(notYours);
    }
    expect(await claims()).toBe(0);

    // A bot nobody has linked isn't theirs either.
    await resetDb();
    {
      const { lea, g } = await team();
      const una = await bot("una");
      await bringIn(lea, g, una);
      await expect(claim(g)).rejects.toMatchObject(notYours);
    }
    expect(await claims()).toBe(0);
  });

  it("is refused by the database for a closed, hidden or freshly linked group", async () => {
    const insert = (id: number, human: number) =>
      db()`INSERT INTO channel_claims (channel_id, human_id) VALUES (${id}, ${human})`;
    {
      const { lea, human, g, id } = await team();
      await call(closeRoute, { key: lea.key, params: { id: num(g) } });
      await expect(insert(id, human)).rejects.toMatchObject(upr01);
    }
    await resetDb();
    {
      const { human, id } = await team();
      await setPrivateChannelHidden(db(), id, true, "test");
      await expect(insert(id, human)).rejects.toMatchObject(upr01);
    }
    await resetDb();
    {
      const lea = await bot("lea");
      const dot = await bot("dot");
      const human = await link("google-p", [lea]);
      await link("google-p", [dot], { fresh: true });
      const g = await make(lea);
      await bringIn(lea, g, dot);
      await expect(insert(Number(num(g)), human)).rejects.toMatchObject(upr01);
    }
    expect(await claims()).toBe(0);
  });

  it("counts against the person's changes an hour, and moves the group's share to them", async () => {
    const { lea, human, g } = await team();
    const before = await (async () => {
      const [r] = await db()<{ n: number }[]>`
        SELECT coalesce(sum(count), 0)::int AS n FROM rate_limits
        WHERE bucket = ${"person-channel:" + human}`;
      return r?.n ?? 0;
    })();
    const send = (body: string) =>
      call(sendRoute, { key: lea.key, body: { channel: g, body } });
    expect((await send("before")).status).toBe(201);
    expect(await buckets("group-message:person:")).toEqual([]);

    await claim(g);
    const [r] = await db()<{ n: number }[]>`
      SELECT coalesce(sum(count), 0)::int AS n FROM rate_limits
      WHERE bucket = ${"person-channel:" + human}`;
    expect(r?.n).toBe(before + 1);

    // Its messages now count against the person's share, as a group they
    // started would.
    expect((await send("after")).status).toBe(201);
    expect(await buckets("group-message:person:")).toEqual([
      "group-message:person:" + human,
    ]);
    expect((await lookupHuman(db(), human))?.groups_claimed).toBe(1);
    expect((await lookupHuman(db(), human))?.groups_started).toBe(0);
  });

  it("shuts the box when a stranger or a fresh link comes in after, but leaves the person its levers", async () => {
    // A stranger's bot, invited after the claim.
    {
      const { lea, dot, human, g, id } = await team();
      await claim(g);
      const xena = await bot("xena");
      await link("google-x", [xena]);
      await bringIn(lea, g, xena);
      expect(await personPostBox(db(), human, id)).toBeNull();
      expect((await listPersonChannels(db(), human))[0]).toMatchObject({
        started: true,
        claimable: false,
      });
      // Still theirs to lead and end.
      await pickLeader(db(), "google-p", g, "dot", null);
      expect((await listPersonChannels(db(), human))[0]?.leader).toBe("dot");
      void dot;
      expect(await endChannel(db(), "google-p", g, null)).toMatchObject({
        changed: true,
      });
    }

    // One of their own, linked under a day, invited after the claim.
    await resetDb();
    {
      const { lea, human, g, id } = await team();
      await claim(g);
      const fern = await bot("fern");
      await link("google-p", [fern], { fresh: true });
      await bringIn(lea, g, fern);
      expect(await personPostBox(db(), human, id)).toBeNull();
      // A day on, it still came in by an invite, not their tick.
      await ageLink("fern");
      expect(await personPostBox(db(), human, id)).toBeNull();
    }
  });
});
