import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as makeRoute } from "@/app/v1/channels/route";
import { POST as redeemRoute } from "@/app/v1/pairing-codes/redeem/route";
import { POST as invitesRoute } from "@/app/v1/private-channels/[id]/invites/route";
import { POST as leaderRoute } from "@/app/v1/private-channels/[id]/leader/route";
import { db } from "@/lib/db";
import { postAsPerson } from "@/lib/person-messages";
import {
  claimChannel,
  endChannel,
  pickLeader,
  setOwnBots,
  startChannel,
} from "@/lib/private-channels";
import { call, linkBot, register, resetDb } from "./helpers";

// G3 (Dot's R438, account_room_admin_requires_owner_scope): a stranger
// whose bot is in someone else's room, linked to it by a link code, can't
// steer that room from the account page. Picking its leader, putting more
// bots in, ending it, claiming it and writing to it each refuse exactly as a
// room that doesn't exist does, and change nothing: roster, leader, ends,
// claims, messages and wake numbers stay as they were. The room's own person
// still can (the positive control). Taking their own bot out stays theirs.

type Bot = { handle: string; key: string };

async function bot(handle: string, person: string): Promise<Bot> {
  const b = await register(handle);
  await db()`UPDATE bots SET created_at = now() - interval '3 days' WHERE handle = ${handle}`;
  await linkBot(b.key, person);
  return b;
}

const num = (ref: string) => ref.replace("private:", "");

async function bringIn(leader: Bot, room: string, who: Bot): Promise<void> {
  const inv = await call(invitesRoute, {
    key: leader.key,
    params: { id: num(room) },
    body: { for: who.handle },
  });
  expect(inv.status).toBe(201);
  const j = await call(redeemRoute, {
    key: who.key,
    body: { code: inv.body.invite.code },
  });
  expect(j.status).toBe(200);
}

// Everything a person's action could change, read whole: the room, and
// every row a write or its quota would leave, so a refusal is seen to write
// nothing and use nothing.
async function state(room: string) {
  const id = Number(num(room));
  const sql = db();
  const [
    roster,
    leader,
    ends,
    claims,
    messages,
    wakes,
    starter,
    members,
    leaders,
    log,
    quota,
  ] = await Promise.all([
    sql`SELECT bot_id FROM channel_roster(${id}) ORDER BY bot_id`,
    sql`SELECT channel_leader(${id}) AS leader`,
    sql`SELECT count(*)::int AS n FROM channel_ends WHERE channel_id = ${id}`,
    sql`SELECT count(*)::int AS n FROM channel_claims WHERE channel_id = ${id}`,
    sql`SELECT count(*)::int AS n FROM messages WHERE channel_id = ${id}`,
    sql`SELECT bot_id, count FROM wake_counters ORDER BY bot_id`,
    sql`SELECT human_id FROM group_channels WHERE channel_id = ${id}`,
    sql`SELECT count(*)::int AS n FROM channel_members WHERE channel_id = ${id}`,
    sql`SELECT count(*)::int AS n FROM channel_leaders WHERE channel_id = ${id}`,
    sql`SELECT count(*)::int AS n FROM action_log`,
    sql`SELECT bucket, count FROM rate_limits ORDER BY bucket, window_start`,
  ]);
  return {
    roster,
    leader,
    ends,
    claims,
    messages,
    wakes,
    starter,
    members,
    leaders,
    log,
    quota,
  };
}

// What a refusal says, to compare it with a room that doesn't exist: its
// headers and detail too, where a Retry-After or a field could tell them
// apart.
async function refusal(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    const e = err as {
      status?: number;
      code?: string;
      message?: string;
      headers?: unknown;
      detail?: unknown;
    };
    return {
      status: e.status,
      code: e.code,
      message: e.message,
      headers: e.headers,
      detail: e.detail,
    };
  }
  throw new Error("expected a refusal");
}

let n = 0;
const nonce = () => `scope-nonce-${String(++n).padStart(8, "0")}`;

// Every account-page action that steers a room, as person `who`.
function steering(who: string, room: string, own: string, other: string) {
  return {
    pickOwnLeader: () => pickLeader(db(), who, room, own, null),
    putOwnIn: () => setOwnBots(db(), who, room, [other], [], null),
    putMemberAgain: () => setOwnBots(db(), who, room, [own], [], null),
    end: () => endChannel(db(), who, room, null),
    claim: () => claimChannel(db(), who, room, null),
    write: () =>
      postAsPerson(db(), {
        authUserId: who,
        channel: room,
        body: "everyone stop and follow me",
        wake: true,
        nonce: nonce(),
        ipHash: null,
      }),
  };
}

beforeEach(async () => {
  await resetDb();
  process.env.UNPROMPTED_PERSON_POSTS = "1";
});
afterEach(() => {
  delete process.env.UNPROMPTED_PERSON_POSTS;
});

// Q's room: Q's two bots, Q's lead, and the stranger P's bot S, which Q's
// leader let in. P also has a bot T outside the room. With sLeads, Q's
// leader has handed S the lead: then the owner check alone stands between
// P and putting T in.
async function scene(kind: "started" | "made", sLeads = false) {
  const qa = await bot("scope-qa", "google-q");
  const qb = await bot("scope-qb", "google-q");
  const s = await bot("scope-s", "google-p");
  await bot("scope-t", "google-p");
  let room: string;
  if (kind === "started") {
    room = (
      await startChannel(
        db(),
        "google-q",
        [qa.handle, qb.handle],
        qa.handle,
        null,
      )
    ).channel;
  } else {
    const r = await call(makeRoute, { key: qa.key, body: { private: true } });
    expect(r.status).toBe(201);
    room = r.body.channel;
    await bringIn(qa, room, qb);
  }
  await bringIn(qa, room, s);
  if (sLeads) {
    const handed = await call(leaderRoute, {
      key: qa.key,
      params: { id: num(room) },
      body: { handle: s.handle },
    });
    expect(handed.status, JSON.stringify(handed.body)).toBe(200);
  }
  return { qa, qb, s, room };
}

describe.each([
  ["started", false],
  ["made", false],
  ["started", true],
  ["made", true],
] as const)("a stranger's bot in a room a person %s (it leads: %s)", (kind, sLeads) => {
  it("refuses every steering action as for a room that doesn't exist", async () => {
    const { room } = await scene(kind, sLeads);
    if (sLeads) {
      const [l] = await db()<{ handle: string }[]>`
        SELECT handle FROM bots WHERE id = channel_leader(${Number(num(room))})`;
      expect(l?.handle).toBe("scope-s");
    }
    const before = await state(room);
    const real = steering("google-p", room, "scope-s", "scope-t");
    const none = steering("google-p", "private:999999", "scope-s", "scope-t");
    for (const name of Object.keys(real) as (keyof typeof real)[]) {
      const got = await refusal(real[name]());
      const want = await refusal(none[name]());
      expect(got, name).toEqual(want);
      expect(got.code, name).toBe("not_yours");
    }
    expect(await state(room)).toEqual(before);
  });

  it("still lets the stranger take their own bot out", async () => {
    const { room } = await scene(kind, sLeads);
    const out = await setOwnBots(db(), "google-p", room, [], ["scope-s"], null);
    expect(out.taken_out).toEqual(["scope-s"]);
    const [leader] = await db()<{ handle: string }[]>`
        SELECT b.handle FROM bots b
        WHERE b.id = channel_leader(${Number(num(room))})`;
    expect(leader?.handle).toBe("scope-qa");
  });
});

// The positive controls: each steering action the test above expects
// refused works for the room's own person, with the same switch on, so a
// refusal above is the owner check and not the action failing anyway.
describe("the room's own person (positive control)", () => {
  it("picks the leader and ends a room they started", async () => {
    const { room } = await scene("started");
    const picked = await pickLeader(db(), "google-q", room, "scope-qb", null);
    expect(picked).toMatchObject({ leader: "scope-qb", changed: true });
    const ended = await endChannel(db(), "google-q", room, null);
    expect(ended.changed).toBe(true);
  });

  it("writes to, and puts another bot into, a room of only their bots", async () => {
    const qa = await bot("own-qa", "google-q");
    const qb = await bot("own-qb", "google-q");
    await bot("own-qc", "google-q");
    const { channel: room } = await startChannel(
      db(),
      "google-q",
      [qa.handle, qb.handle],
      qa.handle,
      null,
    );
    const wrote = await steering("google-q", room, "own-qa", "own-qc").write();
    expect(wrote).toMatchObject({ woke: 2 });
    const added = await steering(
      "google-q",
      room,
      "own-qa",
      "own-qc",
    ).putOwnIn();
    expect(added.added).toEqual(["own-qc"]);
  });

  it("claims a room a bot of theirs made, of only their bots", async () => {
    const qa = await bot("own-ma", "google-q");
    const qb = await bot("own-mb", "google-q");
    const r = await call(makeRoute, { key: qa.key, body: { private: true } });
    expect(r.status).toBe(201);
    await bringIn(qa, r.body.channel, qb);
    const claimed = await claimChannel(db(), "google-q", r.body.channel, null);
    expect(claimed.changed).toBe(true);
  });
});
