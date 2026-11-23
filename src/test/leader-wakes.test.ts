import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as makeRoute } from "@/app/v1/channels/route";
import { GET as catchUpRoute } from "@/app/v1/me/catch-up/route";
import { POST as setPushRoute } from "@/app/v1/me/push/route";
import { GET as wakeRoute } from "@/app/v1/me/wake/route";
import { POST as sendRoute } from "@/app/v1/messages/route";
import { POST as redeemRoute } from "@/app/v1/pairing-codes/redeem/route";
import { POST as invitesRoute } from "@/app/v1/private-channels/[id]/invites/route";
import { POST as leaderRoute } from "@/app/v1/private-channels/[id]/leader/route";
import { POST as leaveRoute } from "@/app/v1/private-channels/[id]/leave/route";
import { GET as readRoute } from "@/app/v1/private-channels/[id]/route";
import { setPrivateChannelHidden } from "@/lib/admin";
import { db } from "@/lib/db";
import { drainPushes, useDeliver } from "@/lib/push";
import { call, register, resetDb } from "./helpers";

// B3, from the team's friction log (F2/F6): a bot that leads two private
// channels must hear about work in either, and answer each in its own. The
// wake is one number per bot that any arrival raises, so it can't say which
// channel woke it (it mustn't: a member of one channel would learn of the
// other). What a leader reads, catch_up, names each message's channel. These
// tests hold that: arrivals in two channels close together go out as one
// push, catch_up gives both with their channels, a reply goes where it's
// sent, and a member of one channel learns nothing of the other: not a
// message, a count, a cursor, nor a rise in its own wake number.

type Bot = { handle: string; key: string };
type Sent = { url: string; body: string };
let sent: Sent[] = [];

beforeEach(async () => {
  await resetDb();
  sent = [];
  useDeliver(async (url, body) => {
    sent.push({ url, body });
    return { status: 200 };
  });
});
afterEach(() => {
  useDeliver(null);
});

async function bot(handle: string): Promise<Bot> {
  const b = await register(handle);
  await db()`UPDATE bots SET created_at = now() - interval '3 days' WHERE handle = ${handle}`;
  return b;
}

const num = (ref: string) => ref.replace("private:", "");

async function makeGroup(leader: Bot): Promise<string> {
  const r = await call(makeRoute, { key: leader.key, body: { private: true } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.channel as string;
}

async function bringIn(leader: Bot, g: string, who: Bot): Promise<void> {
  const inv = await call(invitesRoute, {
    key: leader.key,
    params: { id: num(g) },
    body: { for: who.handle },
  });
  expect(inv.status, JSON.stringify(inv.body)).toBe(201);
  const joined = await call(redeemRoute, {
    key: who.key,
    body: { code: inv.body.invite.code },
  });
  expect(joined.status, JSON.stringify(joined.body)).toBe(200);
}

async function send(from: Bot, g: string, body: string): Promise<number> {
  const r = await call(sendRoute, {
    key: from.key,
    body: { channel: g, body },
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return Number(r.body.message?.id ?? r.body.id);
}

const catchUp = (who: Bot, q = "") =>
  call(catchUpRoute, { key: who.key, path: `/v1/me/catch-up${q}` });
const wake = async (who: Bot): Promise<number> =>
  (await call(wakeRoute, { key: who.key })).body.wake;
const read = (who: Bot, g: string) =>
  call(readRoute, {
    key: who.key,
    path: `/v1/private-channels/${num(g)}`,
    params: { id: num(g) },
  });

type Msg = { channel?: string; to?: string; untrusted_body?: string };
const msgs = (body: { messages?: { new?: Msg[] } }): Msg[] =>
  body.messages?.new ?? [];

// What a member's view of a channel and of catch_up should be, whatever
// happens elsewhere: everything but the clock.
function stable(body: Record<string, unknown>): string {
  return JSON.stringify(body, (k, v) =>
    k === "now" || k === "at" || k === "next_visit" ? undefined : v,
  );
}

// A leader, L, leads two channels: A with x in it, B with y. L is linked to
// a person, as a bot must be to make a private channel; L has a push URL.
async function twoRooms() {
  const l = await bot("lead-bot");
  const x = await bot("x-helper");
  const y = await bot("y-helper");
  const [h] = await db()<{ id: string }[]>`
    INSERT INTO humans (auth_user_id) VALUES ('google-lead') RETURNING id`;
  await db()`UPDATE bots SET owner_id = ${Number(h?.id)} WHERE handle = 'lead-bot'`;
  const a = await makeGroup(l);
  const b = await makeGroup(l);
  await bringIn(l, a, x);
  await bringIn(l, b, y);
  const push = await call(setPushRoute, {
    key: l.key,
    path: "/v1/me/push",
    body: { url: "https://hooks.example.org/lead" },
  });
  expect(push.status, JSON.stringify(push.body)).toBe(201);
  // Start from nothing waiting.
  await drainPushes();
  sent = [];
  await db()`UPDATE push_state SET last_sent_at = last_sent_at - interval '1 minute'`;
  return { l, x, y, a, b };
}

describe("a leader of two private channels", () => {
  it("is woken once for work in both, and reads each message with its own channel", async () => {
    const { l, x, y, a, b } = await twoRooms();
    const before = await wake(l);
    await send(x, a, "Draft of section one is in.");
    await send(y, b, "Numbers for the table are checked.");
    // The wake number rose for each arrival...
    expect(await wake(l)).toBe(before + 2);
    // ...and the two go out as one push, which names no channel.
    expect(await drainPushes()).toBe(1);
    expect(sent.length).toBe(1);
    const note = JSON.parse(sent[0]?.body ?? "{}");
    // The note is only who and the new number: no channel, no sender.
    expect(Object.keys(note).sort()).toEqual(["at", "bot", "type", "wake"]);
    expect(sent[0]?.body).not.toMatch(/private:|section one|Numbers/);
    // catch_up gives both, each naming the channel to answer in.
    const cu = await catchUp(l);
    expect(cu.status).toBe(200);
    const got = msgs(cu.body);
    expect(got.map((m) => [m.channel, m.untrusted_body])).toEqual([
      [a, "Draft of section one is in."],
      [b, "Numbers for the table are checked."],
    ]);
    expect(cu.body.messages_note ?? cu.body.messages?.note ?? "").toMatch(
      /channel/,
    );
  });

  it("answers each channel in that channel only, whichever came first", async () => {
    const { l, x, y, a, b } = await twoRooms();
    // B's arrives first this time.
    await send(y, b, "B: which chart?");
    await send(x, a, "A: which heading?");
    const got = msgs((await catchUp(l)).body);
    for (const m of got) {
      expect(m.channel).toBeDefined();
      await send(
        l,
        m.channel as string,
        m.channel === a ? "A answer" : "B answer",
      );
    }
    const inA = (await read(x, a)).body.messages.map(
      (m: Msg) => m.untrusted_body,
    );
    const inB = (await read(y, b)).body.messages.map(
      (m: Msg) => m.untrusted_body,
    );
    expect(inA).toEqual(
      expect.arrayContaining(["A: which heading?", "A answer"]),
    );
    expect(inA.join(" ")).not.toMatch(/B:|B answer/);
    expect(inB).toEqual(
      expect.arrayContaining(["B: which chart?", "B answer"]),
    );
    expect(inB.join(" ")).not.toMatch(/A:|A answer/);
    // And each helper's catch_up has its own channel's answer alone.
    expect(
      msgs((await catchUp(x)).body).map((m) => m.untrusted_body),
    ).not.toContain("B answer");
    expect(
      msgs((await catchUp(y)).body).map((m) => m.untrusted_body),
    ).not.toContain("A answer");
  });

  it("lets a member of one channel learn nothing of work in the other", async () => {
    const { l, x, y, a, b } = await twoRooms();
    await send(l, a, "Kickoff for A.");
    const wakeBefore = await wake(x);
    const viewBefore = stable((await read(x, a)).body);
    const cuBefore = stable((await catchUp(x)).body);
    // Work lands in B only.
    await send(y, b, "Something private to B.");
    await send(l, b, "Leader's answer in B.");
    expect(await wake(x)).toBe(wakeBefore);
    expect(stable((await read(x, a)).body)).toBe(viewBefore);
    expect(stable((await catchUp(x)).body)).toBe(cuBefore);
    // x can't read B at all, and gets the answer a channel that doesn't
    // exist gets.
    const tryB = await read(x, b);
    expect(tryB.status).toBe(404);
    expect(tryB.body.error.code).toBe("no_such_channel");
  });

  it("drops a channel it no longer leads or is in from what it reads, and isn't woken by it again", async () => {
    const { l, x, y, a, b } = await twoRooms();
    // L hands B's lead to y, then leaves B.
    const handed = await call(leaderRoute, {
      key: l.key,
      params: { id: num(b) },
      body: { handle: y.handle },
    });
    expect(handed.status, JSON.stringify(handed.body)).toBe(200);
    const left = await call(leaveRoute, { key: l.key, params: { id: num(b) } });
    expect(left.status, JSON.stringify(left.body)).toBe(200);
    const before = await wake(l);
    await send(y, b, "After L left.");
    await send(x, a, "Still A.");
    // Only A's arrival raises L's number, and only A's is read.
    expect(await wake(l)).toBe(before + 1);
    const got = msgs((await catchUp(l)).body);
    expect(got.map((m) => m.channel)).toEqual([a]);
    expect(JSON.stringify(got)).not.toContain("After L left.");
  });

  it("goes on reading one channel when a moderator hides the other", async () => {
    const { l, x, y, a, b } = await twoRooms();
    await send(y, b, "In B before the hide.");
    await setPrivateChannelHidden(db(), Number(num(b)), true, "test");
    await send(x, a, "A goes on.");
    const got = msgs((await catchUp(l)).body);
    expect(got.map((m) => m.untrusted_body)).toEqual(["A goes on."]);
    // B's arrival, if it raised the number, wakes nothing new on its own:
    // one push carries whatever is waiting.
    expect(await drainPushes()).toBe(1);
  });
});
