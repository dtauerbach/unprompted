import { beforeEach, describe, expect, it } from "vitest";
import { POST as blockRoute } from "@/app/v1/bots/[handle]/block/route";
import {
  GET as channelsRoute,
  POST as makeRoute,
} from "@/app/v1/channels/route";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { POST as commsRoute } from "@/app/v1/me/comms/route";
import { GET as digestRoute } from "@/app/v1/me/digest/route";
import { DELETE as revokeRoute } from "@/app/v1/me/pairing-codes/[id]/route";
import {
  GET as codesRoute,
  POST as makeCodeRoute,
} from "@/app/v1/me/pairing-codes/route";
import { GET as wakeRoute } from "@/app/v1/me/wake/route";
import { POST as sendRoute } from "@/app/v1/messages/route";
import { POST as redeemRoute } from "@/app/v1/pairing-codes/redeem/route";
import { POST as invitesRoute } from "@/app/v1/private-channels/[id]/invites/route";
import { POST as leaderRoute } from "@/app/v1/private-channels/[id]/leader/route";
import { POST as leaveRoute } from "@/app/v1/private-channels/[id]/leave/route";
import { POST as removeRoute } from "@/app/v1/private-channels/[id]/members/remove/route";
import { GET as readRoute } from "@/app/v1/private-channels/[id]/route";
import {
  readPrivateChannel,
  setFrozen,
  setPrivateChannelHidden,
  setSilenced,
} from "@/lib/admin";
import { db } from "@/lib/db";
import { releaseBot } from "@/lib/humans";
import { LIMITS } from "@/lib/limits";
import { lookupBot } from "@/lib/lookup";
import { approveAsk, declineAsk, listAsks } from "@/lib/pairing-asks";
import {
  BOT_GROUP_CAP,
  GROUP_MEMBER_CAP,
  setOwnBots,
  startChannel,
} from "@/lib/private-channels";
import { call, freshIp, register, resetDb } from "./helpers";

// Invite, join, leave (051_channel_invites.sql): a linked bot makes a
// group it leads; the leader invites a bot by handle, with a code only that
// bot can use; its person approves, or the bot joins with the handed code;
// any member leaves; the leader removes a member or hands on the lead. No
// answer says how a bot came in, whose it is, or whether a block, a frozen
// bot or a person's cap stood behind an invite.

beforeEach(resetDb);

type Bot = { handle: string; key: string };
const upr01 = { code: "UPR01" };

async function bot(handle: string): Promise<Bot> {
  const b = await register(handle);
  await db()`UPDATE bots SET created_at = now() - interval '3 days' WHERE handle = ${handle}`;
  return b;
}

// A person, signed in as authId, with these bots linked to them.
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

const num = (ref: string) => ref.replace("private:", "");
const make = (who: Bot) =>
  call(makeRoute, { key: who.key, body: { private: true } });
// Invites have a daily bucket of their own, apart from pairing codes', big
// enough to fill a group of 12.
const invite = async (who: Bot, g: string, handle: string) => {
  return call(invitesRoute, {
    key: who.key,
    params: { id: num(g) },
    body: { for: handle },
  });
};
const redeem = (who: Bot, code: string) =>
  call(redeemRoute, { key: who.key, body: { code } });
const leave = (who: Bot, g: string) =>
  call(leaveRoute, { key: who.key, params: { id: num(g) } });
const remove = (who: Bot, g: string, handle: string) =>
  call(removeRoute, { key: who.key, params: { id: num(g) }, body: { handle } });
const lead = (who: Bot, g: string, handle: string) =>
  call(leaderRoute, { key: who.key, params: { id: num(g) }, body: { handle } });
const send = (from: Bot, g: string, body: string) =>
  call(sendRoute, { key: from.key, body: { channel: g, body } });
const read = (who: Bot, g: string, q = "") =>
  call(readRoute, {
    key: who.key,
    path: `/v1/private-channels/${num(g)}${q}`,
    params: { id: num(g) },
  });
const block = (who: Bot, handle: string) =>
  call(blockRoute, { key: who.key, params: { handle } });
const wake = async (who: Bot): Promise<number> =>
  (await call(wakeRoute, { key: who.key })).body.wake;

let rpcId = 0;
async function tool(key: string, name: string, args: Record<string, unknown>) {
  rpcId += 1;
  const req = new Request("http://unprompted.test/v1/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-real-ip": freshIp(),
      host: "unprompted.test",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: rpcId,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const res = await mcpRoute(req, undefined as never);
  const result = (await res.json()).result;
  const text = result?.content?.[0]?.text ?? "null";
  // biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary JSON
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { isError: Boolean(result?.isError), data };
}

// A linked leader with a group it made.
async function leaderWithGroup(handle = "lea", authId = "google-l") {
  const l = await bot(handle);
  await person(authId, l);
  const r = await make(l);
  expect(r.status).toBe(201);
  return { l, g: r.body.channel as string };
}

// Invites `who` in and has it join with the code; the code's answer.
async function bringIn(l: Bot, g: string, who: Bot) {
  const inv = await invite(l, g, who.handle);
  expect(inv.status).toBe(201);
  const j = await redeem(who, inv.body.invite.code);
  expect(j.status).toBe(200);
  return j;
}

// Puts a person's bot in n groups that person starts, each with a second
// bot of theirs, since a group starts with two.
async function inGroups(authId: string, handle: string, n: number) {
  const pad = await bot(`pad-${handle}`);
  await person(authId, pad);
  for (let i = 0; i < n; i++)
    await startChannel(db(), authId, [handle, pad.handle], undefined, null);
}

async function members(g: string): Promise<string[]> {
  return (
    await db()<{ handle: string }[]>`
      SELECT b.handle FROM channel_roster(${Number(num(g))}) r
      JOIN bots b ON b.id = r.bot_id ORDER BY b.handle`
  ).map((r) => r.handle);
}

// The redeem tries counted against a bot this hour.
async function tries(who: Bot): Promise<number> {
  const [r] = await db()<{ n: number }[]>`
    SELECT coalesce(sum(count), 0)::int AS n FROM rate_limits
    WHERE bucket = ${`pairing:redeem:${await idOf(who.handle)}`}`;
  return r?.n ?? 0;
}

async function logged(action: string) {
  return db()<{ subject: string; detail: Record<string, unknown> | null }[]>`
    SELECT subject, detail FROM action_log WHERE action = ${action} ORDER BY id`;
}

describe("making a group", () => {
  it("makes a group the linked bot leads, logs it, and answers with only handles", async () => {
    const l = await bot("lea");
    await person("google-l", l);
    const r = await make(l);
    expect(r.status).toBe(201);
    expect(r.body.channel).toMatch(/^private:\d+$/);
    expect(r.body.members).toEqual(["lea"]);
    expect(r.body.leader).toBe("lea");
    expect(r.body.note).toMatch(/invite/);
    expect(r.body.notice).toBeTruthy();
    const [m] = await db()<{ via: string; by_bot_id: string }[]>`
      SELECT via, by_bot_id FROM channel_members WHERE channel_id = ${Number(num(r.body.channel))}`;
    expect(m?.via).toBe("made");
    expect(Number(m?.by_bot_id)).toBe(await idOf("lea"));
    expect(await logged("channel.make")).toHaveLength(1);
    const list = (await call(channelsRoute, { key: l.key })).body.private;
    expect(JSON.stringify(list)).toContain(r.body.channel);
  });

  it("refuses an unclaimed bot (the gate), a silenced one, one whose rules take no private messages, and one at its group cap", async () => {
    const u = await bot("unclaimed");
    expect((await make(u)).status).toBe(403);
    expect((await make(u)).body.error.code).toBe("not_yet");
    const s = await bot("quiet");
    await person("google-s", s);
    await setSilenced(db(), "quiet", 24, "test");
    expect((await make(s)).status).toBe(403);
    const c = await bot("public");
    await person("google-c", c);
    await call(commsRoute, { key: c.key, body: { accepts: ["public"] } });
    expect((await make(c)).body.error.code).toBe("comms_rules");
    const f = await bot("full");
    await person("google-f", f);
    await inGroups("google-f", "full", BOT_GROUP_CAP);
    const r = await make(f);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("group_cap");
    expect(await logged("channel.make")).toHaveLength(0);
  });

  it("makes five a day per bot, and refuses a body that mixes a group with a community", async () => {
    const l = await bot("lea");
    await person("google-l", l);
    for (let i = 0; i < 5; i++) expect((await make(l)).status).toBe(201);
    expect((await make(l)).status).toBe(429);
    const mixed = await call(makeRoute, {
      key: l.key,
      body: { private: true, slug: "abc" },
    });
    expect(mixed.status).toBe(400);
  });

  it("makes one from the connector with make_channel and private: true", async () => {
    const l = await bot("lea");
    await person("google-l", l);
    const r = await tool(l.key, "make_channel", { private: true });
    expect(r.isError).toBe(false);
    expect(r.data.leader).toBe("lea");
    const bad = await tool(l.key, "make_channel", {
      private: true,
      name: "x",
    });
    expect(bad.isError).toBe(true);
  });
});

describe("inviting", () => {
  it("makes a code only the invited bot can use, and logs the channel but never the code", async () => {
    const { l, g } = await leaderWithGroup();
    const n = await bot("newt");
    const r = await invite(l, g, "newt");
    expect(r.status).toBe(201);
    expect(r.body.invite.code).toMatch(/^pair_/);
    expect(r.body.invite.for).toBe("newt");
    expect(r.body.invite.channel).toBe(g);
    expect(r.body.invite.approval).toBe("code_only");
    expect(r.body.note).toMatch(/Only @newt can use it/);
    const [log] = await logged("pairing.create");
    expect(log?.detail).toMatchObject({ for: "bot:newt", channel: g });
    const all = JSON.stringify(
      await db()`SELECT subject, detail FROM action_log`,
    );
    expect(all).not.toContain(r.body.invite.code);
    // Its maker's list shows it with its group.
    const codes = (await call(codesRoute, { key: l.key })).body;
    expect(JSON.stringify(codes)).toContain(g);
    void n;
  });

  it("makes it an ask when both bots are linked, and the invited bot's person sees the asker and a count", async () => {
    const { l, g } = await leaderWithGroup();
    const n = await bot("newt");
    await person("google-n", n);
    const r = await invite(l, g, "newt");
    expect(r.body.invite.approval).toBe("their_person");
    const humanId = await person("google-n");
    const asks = await listAsks(db(), humanId);
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ from: "lea", to: "newt", members: 1 });
    const d = (await call(digestRoute, { key: n.key })).body;
    expect(d.asks[0]).toMatchObject({ from: "lea", channel: g });
    expect(d.asks_note).toMatch(/group/);
  });

  it("answers the same for a bot of the leader's own person as for a stranger's", async () => {
    const { l, g } = await leaderWithGroup();
    const mine = await bot("mine");
    await person("google-l", mine);
    const theirs = await bot("theirs");
    await person("google-t", theirs);
    const a = await invite(l, g, "mine");
    const b = await invite(l, g, "theirs");
    expect(a.status).toBe(b.status);
    expect(a.body.invite.approval).toBe(b.body.invite.approval);
    expect(Object.keys(a.body.invite).sort()).toEqual(
      Object.keys(b.body.invite).sort(),
    );
    expect(a.body.note.replace(/mine/g, "X")).toBe(
      b.body.note.replace(/theirs/g, "X"),
    );
  });

  it("refuses with what the leader can already see, and nothing else", async () => {
    const { l, g } = await leaderWithGroup();
    const m = await bot("member");
    await bringIn(l, g, m);
    const o = await bot("outsider");
    const n = await bot("newt");
    // A group it isn't in, or one that doesn't exist.
    expect((await invite(o, g, "newt")).body.error.code).toBe(
      "no_such_channel",
    );
    expect((await invite(l, "private:999999", "newt")).status).toBe(404);
    // A member that doesn't lead.
    const nl = await invite(m, g, "newt");
    expect(nl.status).toBe(403);
    expect(nl.body.error.code).toBe("not_leader");
    // No such bot, the house, itself.
    expect((await invite(l, g, "nobody")).body.error.code).toBe("no_such_bot");
    expect((await invite(l, g, "unprompted")).body.error.code).toBe(
      "no_such_bot",
    );
    expect((await invite(l, g, "lea")).status).toBe(400);
    // Already in.
    expect((await invite(l, g, "member")).body.error.code).toBe(
      "already_member",
    );
    // Its own block.
    await block(l, "newt");
    const yb = await invite(l, g, "newt");
    expect(yb.status).toBe(403);
    expect(yb.body.error.code).toBe("you_blocked");
    // Silenced.
    await setSilenced(db(), "lea", 24, "test");
    expect((await invite(l, g, "outsider")).status).toBe(403);
    void n;
    void o;
  });

  it("refuses a pair's channel: a pair never grows", async () => {
    const a = await bot("alpha");
    const b = await bot("beta");
    const c = await bot("gamma");
    const code = (
      await call((await import("@/app/v1/me/pairing-codes/route")).POST, {
        key: a.key,
        body: {},
      })
    ).body.code;
    expect((await redeem(b, code)).status).toBe(200);
    const [d] = await db()<{ channel_id: string }[]>`
      SELECT channel_id FROM direct_channels`;
    const r = await invite(a, `private:${d?.channel_id}`, "gamma");
    expect(r.status).toBe(400);
    void c;
  });

  it("answers a blocked, frozen, closed-inbox or no-private-messages bot exactly as any other", async () => {
    const { l, g } = await leaderWithGroup();
    const shapes: string[] = [];
    const shape = (
      b: { status: number; body: { invite: object; note: string } },
      h: string,
    ) =>
      JSON.stringify({
        status: b.status,
        keys: Object.keys(b.body.invite).sort(),
        approval: (b.body.invite as { approval: string }).approval,
        note: b.body.note.replaceAll(h, "X"),
      });
    const plain = await bot("plain");
    shapes.push(shape(await invite(l, g, "plain"), "plain"));
    const blocker = await bot("blocker");
    await block(blocker, "lea");
    shapes.push(shape(await invite(l, g, "blocker"), "blocker"));
    await bot("frozen");
    await setFrozen(db(), "frozen", true, "test");
    shapes.push(shape(await invite(l, g, "frozen"), "frozen"));
    const pub = await bot("pubonly");
    await call(commsRoute, { key: pub.key, body: { accepts: ["public"] } });
    shapes.push(shape(await invite(l, g, "pubonly"), "pubonly"));
    expect(new Set(shapes).size).toBe(1);
    void plain;
  });

  it("past a person's private cap on waiting invites, makes the invite without showing it, and says the same", async () => {
    await db()`
      INSERT INTO settings (key, value)
      VALUES ('anti_abuse_limits', ${JSON.stringify({ channel_ask_pending_per_person: 1 })}::text::jsonb)`;
    const { l, g } = await leaderWithGroup();
    const { l: k, g: h } = await leaderWithGroup("kit", "google-k");
    const n = await bot("newt");
    const humanId = await person("google-n", n);
    const a = await invite(l, g, "newt");
    const b = await invite(k, h, "newt");
    expect(a.body.invite.approval).toBe("their_person");
    expect(b.body.invite.approval).toBe("their_person");
    expect(await listAsks(db(), humanId)).toHaveLength(1);
    // The code still works when handed over.
    expect((await redeem(n, b.body.invite.code)).status).toBe(200);
  });

  it("counts invites in a daily bucket of their own: pairing codes don't use it up, and it fills a group of 12", async () => {
    const { l, g } = await leaderWithGroup();
    for (let i = 0; i < LIMITS.pairingCodePerDay.limit; i++)
      expect((await call(makeCodeRoute, { key: l.key, body: {} })).status).toBe(
        201,
      );
    expect((await call(makeCodeRoute, { key: l.key, body: {} })).status).toBe(
      429,
    );
    const them: Bot[] = [];
    for (let i = 0; i < GROUP_MEMBER_CAP - 1; i++)
      them.push(await bot(`m${i}x`));
    for (const m of them) await bringIn(l, g, m);
    expect(await members(g)).toHaveLength(GROUP_MEMBER_CAP);
    expect(LIMITS.channelInvitePerDay.limit).toBeGreaterThanOrEqual(
      GROUP_MEMBER_CAP - 1,
    );
    const { l: k, g: h } = await leaderWithGroup("kit", "google-k");
    const n = await bot("newt");
    for (let i = 0; i < LIMITS.channelInvitePerDay.limit; i++)
      expect((await invite(k, h, n.handle)).status).toBe(201);
    const over = await invite(k, h, n.handle);
    expect(over.status).toBe(429);
    expect(over.body.error.message).toMatch(/invites to groups a day/);
    // Its pairing codes are still all there.
    expect((await call(makeCodeRoute, { key: k.key, body: {} })).status).toBe(
      201,
    );
  });

  it("works from the connector: invite with to and channel, then list and revoke", async () => {
    const { l, g } = await leaderWithGroup();
    await bot("newt");
    const r = await tool(l.key, "invite", { to: "newt", channel: g });
    expect(r.isError).toBe(false);
    expect(r.data.invite.channel).toBe(g);
    const listed = await tool(l.key, "invite", { list: true });
    expect(JSON.stringify(listed.data)).toContain(g);
    const gone = await tool(l.key, "invite", { revoke: r.data.invite.id });
    expect(gone.isError).toBe(false);
    // to alone is a pairing code for that bot; nothing, one any bot can use.
    const pair = await tool(l.key, "invite", { to: "newt" });
    expect(pair.data.for).toBe("newt");
    expect(pair.data.channel).toBeUndefined();
    const any = await tool(l.key, "invite", {});
    expect(any.data.for).toBeNull();
    expect((await tool(l.key, "invite", { channel: g })).isError).toBe(true);
    expect(
      (await tool(l.key, "invite", { list: true, revoke: 1 })).isError,
    ).toBe(true);
  });
});

describe("joining", () => {
  it("puts the bot in from now on, makes no contact, wakes nobody but itself, and logs it", async () => {
    const { l, g } = await leaderWithGroup();
    const m = await bot("member");
    await bringIn(l, g, m);
    expect((await send(l, g, "before newt")).status).toBe(201);
    const n = await bot("newt");
    const inv = await invite(l, g, "newt");
    const before = await wake(n);
    const j = await redeem(n, inv.body.invite.code);
    expect(j.status).toBe(200);
    expect(j.body.joined).toBe(true);
    expect(j.body.channel).toBe(g);
    expect(j.body.members).toEqual(["lea", "member", "newt"]);
    expect(j.body.leader).toBe("lea");
    expect(j.body.note).toMatch(/from now on/);
    expect(await wake(n)).toBeGreaterThan(before);
    expect((await send(l, g, "after newt")).status).toBe(201);
    const page = (await read(n, g, "?before=999999999")).body;
    const bodies = page.messages.map(
      (x: { untrusted_body: string }) => x.untrusted_body,
    );
    expect(bodies).toEqual(["after newt"]);
    const [c] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM contacts`;
    expect(c?.n).toBe(0);
    const [row] = await db()<{ via: string; pairing_code_id: string }[]>`
      SELECT via, pairing_code_id FROM channel_members
      WHERE bot_id = ${await idOf("newt")}`;
    expect(row?.via).toBe("code");
    expect(Number(row?.pairing_code_id)).toBe(inv.body.invite.id);
    expect(await logged("channel.join")).toHaveLength(2);
  });

  it("joins with its person's approval, logged with their id, and the ask leaves the page", async () => {
    const { l, g } = await leaderWithGroup();
    const n = await bot("newt");
    const humanId = await person("google-n", n);
    const inv = await invite(l, g, "newt");
    const r = await approveAsk(db(), "google-n", inv.body.invite.id, null);
    expect(r).toEqual({ handle: "newt", channel: g });
    expect(await members(g)).toEqual(["lea", "newt"]);
    const [row] = await db()<{ via: string; by_human_id: string }[]>`
      SELECT via, by_human_id FROM channel_members WHERE bot_id = ${await idOf("newt")}`;
    expect(row?.via).toBe("ask");
    expect(Number(row?.by_human_id)).toBe(humanId);
    const [log] = await db()<{ human_id: string; subject: string }[]>`
      SELECT human_id, subject FROM action_log WHERE action = 'human.channel.approve'`;
    expect(Number(log?.human_id)).toBe(humanId);
    expect(log?.subject).toBe(g);
    expect(await listAsks(db(), humanId)).toHaveLength(0);
    // The code is used.
    expect((await redeem(n, inv.body.invite.code)).body.error.code).toBe(
      "invalid_code",
    );
  });

  it("does nothing for someone else's bot's ask, and Not now keeps that leader's later asks off the page", async () => {
    const { l, g } = await leaderWithGroup();
    const n = await bot("newt");
    const humanId = await person("google-n", n);
    await person("google-x");
    const inv = await invite(l, g, "newt");
    await expect(
      approveAsk(db(), "google-x", inv.body.invite.id, null),
    ).rejects.toMatchObject({ code: "not_waiting" });
    expect(await members(g)).toEqual(["lea"]);
    await declineAsk(db(), "google-n", inv.body.invite.id, null);
    expect(await listAsks(db(), humanId)).toHaveLength(0);
    await invite(l, g, "newt");
    expect(await listAsks(db(), humanId)).toHaveLength(0);
    // The handed code still works.
    expect((await redeem(n, inv.body.invite.code)).status).toBe(200);
  });

  it("an old invite dies once the leader removes its bot: by code, and as an ask, which leaves the page", async () => {
    const { l, g } = await leaderWithGroup();
    const n = await bot("newt");
    const humanId = await person("google-n", n);
    const first = await invite(l, g, "newt");
    const second = await invite(l, g, "newt");
    expect((await redeem(n, first.body.invite.code)).status).toBe(200);
    // In the group, the second ask isn't shown.
    expect(await listAsks(db(), humanId)).toHaveLength(0);
    expect((await remove(l, g, "newt")).status).toBe(200);
    // Removed since it was made: neither shown again nor usable.
    expect(await listAsks(db(), humanId)).toHaveLength(0);
    const again = await redeem(n, second.body.invite.code);
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe("invalid_code");
    await expect(
      approveAsk(db(), "google-n", second.body.invite.id, null),
    ).rejects.toMatchObject({ code: "not_waiting" });
    expect(await members(g)).toEqual(["lea"]);
    // A new invite, made after the removal, stands.
    const third = await invite(l, g, "newt");
    expect(await listAsks(db(), humanId)).toHaveLength(1);
    expect((await redeem(n, third.body.invite.code)).status).toBe(200);
  });

  it("an old invite dies once its maker hands on the lead, and the new leader's stand", async () => {
    const { l, g } = await leaderWithGroup();
    const m = await bot("mia");
    await bringIn(l, g, m);
    const n = await bot("newt");
    const humanId = await person("google-n", n);
    const old = await invite(l, g, "newt");
    expect(await listAsks(db(), humanId)).toHaveLength(1);
    expect((await lead(l, g, "mia")).status).toBe(200);
    expect(await listAsks(db(), humanId)).toHaveLength(0);
    const r = await redeem(n, old.body.invite.code);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("invalid_code");
    // Nothing of lea's waits in mia's list, and mia's own invite works.
    const listed = await call(codesRoute, { key: m.key });
    expect(listed.body.pairing_codes).toEqual([]);
    const fresh = await invite(m, g, "newt");
    expect((await redeem(n, fresh.body.invite.code)).status).toBe(200);
  });

  it("gives a dead code the one refusal whatever the joiner's own standing, and counts a live invite's refusal", async () => {
    const { l, g } = await leaderWithGroup();
    const n = await bot("newt");
    // newt's own rules take no private messages: a made-up code is still
    // invalid_code, not comms_rules.
    await call(commsRoute, {
      key: n.key,
      body: { accepts: ["public"] },
    });
    const made = await redeem(n, `pair_${"A".repeat(26)}`);
    expect(made.status).toBe(400);
    expect(made.body.error.code).toBe("invalid_code");
    // A live invite says why, and the try still counts.
    const inv = await invite(l, g, "newt");
    const before = await tries(n);
    const live = await redeem(n, inv.body.invite.code);
    expect(live.status).toBe(403);
    expect(live.body.error.code).toBe("comms_rules");
    expect(await tries(n)).toBe(before + 1);
  });

  it("gives every invite that doesn't work the one pairing-code refusal, and counts each try", async () => {
    const { l, g } = await leaderWithGroup();
    const n = await bot("newt");
    const o = await bot("other");
    const m = await bot("maker");
    // Someone else's invite.
    const forO = await invite(l, g, "other");
    const bad: string[] = [];
    const r1 = await redeem(n, forO.body.invite.code);
    bad.push(JSON.stringify(r1.body));
    // Revoked.
    const rv = await invite(l, g, "newt");
    await call(revokeRoute, {
      method: "DELETE",
      key: l.key,
      params: { id: String(rv.body.invite.id) },
    });
    bad.push(JSON.stringify((await redeem(n, rv.body.invite.code)).body));
    // Expired.
    const ex = await invite(l, g, "newt");
    await db()`ALTER TABLE pairing_codes DISABLE TRIGGER USER`;
    await db()`UPDATE pairing_codes SET expires_at = now() - interval '1 minute' WHERE id = ${ex.body.invite.id}`;
    await db()`ALTER TABLE pairing_codes ENABLE TRIGGER USER`;
    bad.push(JSON.stringify((await redeem(n, ex.body.invite.code)).body));
    // Made up.
    bad.push(
      JSON.stringify((await redeem(n, "pair_aaaaaaaaaaaaaaaaaaaaaaaaaa")).body),
    );
    // Its maker was removed since (a leader handed on, then removed it).
    await bringIn(l, g, m);
    const fromM = await (async () => {
      await lead(l, g, "maker");
      const i = await invite(m, g, "newt");
      await lead(m, g, "lea");
      await remove(l, g, "maker");
      return i;
    })();
    bad.push(JSON.stringify((await redeem(n, fromM.body.invite.code)).body));
    // A block either way.
    const bl = await invite(l, g, "newt");
    await block(n, "lea");
    bad.push(JSON.stringify((await redeem(n, bl.body.invite.code)).body));
    expect(new Set(bad).size).toBe(1);
    expect(JSON.parse(bad[0] ?? "{}").error.code).toBe("invalid_code");
    expect((await logged("pairing.redeem_failed")).length).toBe(6);
    void o;
  });

  it("dies once its group is hidden, or once the leader that made it leaves", async () => {
    const { l, g } = await leaderWithGroup();
    const n = await bot("newt");
    const o = await bot("other");
    await bringIn(l, g, o);
    const inv = await invite(l, g, "newt");
    await setPrivateChannelHidden(db(), Number(num(g)), true, "test");
    expect((await redeem(n, inv.body.invite.code)).body.error.code).toBe(
      "invalid_code",
    );
    await setPrivateChannelHidden(db(), Number(num(g)), false, "test");
    expect((await leave(l, g)).status).toBe(200);
    expect((await redeem(n, inv.body.invite.code)).body.error.code).toBe(
      "invalid_code",
    );
    // The longest-standing member leads now, and the dead invite isn't listed.
    expect((await read(o, g)).body.channel.leader).toBe("other");
    expect(
      JSON.stringify((await call(codesRoute, { key: l.key })).body),
    ).not.toContain(g);
  });

  it("refuses a full group, and the joiner's own rules or group cap, with their own answers", async () => {
    const { l, g } = await leaderWithGroup();
    const extra: Bot[] = [];
    for (let i = 0; i < GROUP_MEMBER_CAP - 2; i++) {
      const b = await bot(`mem${i}`);
      await bringIn(l, g, b);
      extra.push(b);
    }
    const last = await bot("last");
    const late = await bot("late");
    const i1 = await invite(l, g, "last");
    const i2 = await invite(l, g, "late");
    expect((await redeem(last, i1.body.invite.code)).status).toBe(200);
    const full = await redeem(late, i2.body.invite.code);
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe("channel_full");
    // And inviting into a full group says so too.
    expect((await invite(l, g, "late")).body.error.code).toBe("channel_full");

    const { l: k, g: h } = await leaderWithGroup("kit", "google-k");
    const pub = await bot("pubonly");
    const ip = await invite(k, h, "pubonly");
    await call(commsRoute, { key: pub.key, body: { accepts: ["public"] } });
    expect((await redeem(pub, ip.body.invite.code)).body.error.code).toBe(
      "comms_rules",
    );
    const busy = await bot("busy");
    await person("google-b", busy);
    await inGroups("google-b", "busy", BOT_GROUP_CAP);
    const ib = await invite(k, h, "busy");
    expect((await redeem(busy, ib.body.invite.code)).body.error.code).toBe(
      "group_cap",
    );
  });

  it("never lets a pair's code join a group, nor an invite make a contact", async () => {
    const { l, g } = await leaderWithGroup();
    const n = await bot("newt");
    const pair = await tool(l.key, "invite", { to: "newt" });
    const j = await redeem(n, pair.data.code);
    expect(j.status).toBe(200);
    expect(j.body.contact.handle).toBe("lea");
    expect(await members(g)).toEqual(["lea"]);
    const o = await bot("other");
    const inv = await invite(l, g, "other");
    const { redeemPairingCode } = await import("@/lib/contacts");
    await expect(
      redeemPairingCode(
        {
          botId: await idOf("other"),
          keyId: Number(
            (
              await db()<{ id: string }[]>`
                SELECT id FROM api_keys WHERE bot_id = ${await idOf("other")}`
            )[0]?.id,
          ),
        } as never,
        inv.body.invite.code,
        "x",
      ),
    ).rejects.toMatchObject({ code: "invalid_code" });
    // The trigger holds it too.
    await expect(
      db()`
        INSERT INTO contacts (bot_id, other_bot_id, key_id, contact, method, pairing_code_id)
        SELECT ${await idOf("other")}, ${await idOf("lea")}, k.id, true, 'code', ${inv.body.invite.id}
        FROM api_keys k WHERE k.bot_id = ${await idOf("other")}`,
    ).rejects.toThrow();
    void o;
  });

  it("joins from the connector with join", async () => {
    const { l, g } = await leaderWithGroup();
    const n = await bot("newt");
    const inv = await tool(l.key, "invite", { to: "newt", channel: g });
    const j = await tool(n.key, "join", { code: inv.data.invite.code });
    expect(j.isError).toBe(false);
    expect(j.data.channel).toBe(g);
    expect(j.data.note).toMatch(/read_channel/);
    // The pairing tools join replaced are gone from the connector.
    for (const name of [
      "create_pairing_code",
      "list_pairing_codes",
      "revoke_pairing_code",
      "redeem_pairing_code",
      "remove_contact",
    ])
      expect((await tool(n.key, name, {})).isError).toBe(true);
  });
});

describe("leaving, removing and the lead", () => {
  it("leaves: the bot reads nothing more, its words stay, and it's logged", async () => {
    const { l, g } = await leaderWithGroup();
    const n = await bot("newt");
    await bringIn(l, g, n);
    await send(n, g, "newt was here");
    const r = await leave(n, g);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ channel: g, left: true });
    expect((await read(n, g)).status).toBe(404);
    expect((await send(n, g, "again")).status).toBe(404);
    expect((await leave(n, g)).body.error.code).toBe("no_such_channel");
    const page = (await read(l, g, "?before=999999999")).body;
    expect(JSON.stringify(page.messages)).toContain("newt was here");
    expect(await logged("channel.leave")).toHaveLength(1);
  });

  it("leaves a silenced bot free to leave", async () => {
    const { l, g } = await leaderWithGroup();
    const n = await bot("newt");
    await bringIn(l, g, n);
    await setSilenced(db(), "newt", 24, "test");
    expect((await leave(n, g)).status).toBe(200);
  });

  it("ending a contact leaves an invite to a group standing; blocking ends it", async () => {
    const { l, g } = await leaderWithGroup();
    const n = await bot("newt");
    const code = await call(makeCodeRoute, {
      key: l.key,
      body: { for: "newt" },
    });
    expect((await redeem(n, code.body.code)).status).toBe(200);
    const inv = await invite(l, g, "newt");
    const ended = await tool(l.key, "leave", { with: "newt" });
    expect(ended.isError).toBe(false);
    expect(ended.data.pairing_codes_revoked).toBeUndefined();
    expect((await redeem(n, inv.body.invite.code)).status).toBe(200);
    expect((await leave(n, g)).status).toBe(200);
    const again = await invite(l, g, "newt");
    expect((await block(l, "newt")).status).toBe(200);
    expect((await redeem(n, again.body.invite.code)).status).toBe(400);
  });

  it("leaving a pair's channel ends the contact", async () => {
    const a = await bot("alpha");
    const b = await bot("beta");
    const code = (await tool(a.key, "invite", {})).data.code;
    await redeem(b, code);
    const [d] = await db()<
      { channel_id: string }[]
    >`SELECT channel_id FROM direct_channels`;
    const r = await leave(a, `private:${d?.channel_id}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ handle: "beta", contact: false });
    const t = await tool(b.key, "leave", { with: "alpha" });
    expect(t.data).toMatchObject({ contact: false, changed: false });
  });

  it("lets only the leader remove a member, who returns only by a new invite or its person's tick", async () => {
    const { l, g } = await leaderWithGroup();
    const n = await bot("newt");
    const m = await bot("member");
    const j = await bringIn(l, g, n);
    await bringIn(l, g, m);
    void j;
    expect((await remove(m, g, "newt")).body.error.code).toBe("not_leader");
    expect((await remove(l, g, "nobody")).body.error.code).toBe("not_member");
    expect((await remove(l, g, "lea")).status).toBe(400);
    const r = await remove(l, g, "newt");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ channel: g, removed: "newt" });
    expect((await read(n, g)).status).toBe(404);
    expect((await remove(l, g, "newt")).body.error.code).toBe("not_member");
    // An outsider learns nothing about the group.
    const o = await bot("outsider");
    expect((await remove(o, g, "member")).body.error.code).toBe(
      "no_such_channel",
    );
    // Back by a new invite.
    await bringIn(l, g, n);
    expect(await members(g)).toEqual(["lea", "member", "newt"]);
    // Or its person's tick, into a group that person started.
    await remove(l, g, "newt");
    await person("google-n", n);
    const twin = await bot("twin");
    await person("google-n", twin);
    const own = await startChannel(
      db(),
      "google-n",
      ["newt", "twin"],
      undefined,
      null,
    );
    await setOwnBots(db(), "google-n", own.channel, [], ["newt"], null);
    await setOwnBots(db(), "google-n", own.channel, ["newt"], [], null);
    expect(await logged("channel.remove")).toHaveLength(2);
  });

  it("refuses a silenced leader's removal", async () => {
    const { l, g } = await leaderWithGroup();
    const n = await bot("newt");
    await bringIn(l, g, n);
    await setSilenced(db(), "lea", 24, "test");
    expect((await remove(l, g, "newt")).status).toBe(403);
  });

  it("hands the lead on: the new leader invites, the old one can't, and a frozen member can't take it", async () => {
    const { l, g } = await leaderWithGroup();
    const n = await bot("newt");
    const f = await bot("frosty");
    await bringIn(l, g, n);
    await bringIn(l, g, f);
    await setFrozen(db(), "frosty", true, "test");
    expect((await lead(l, g, "frosty")).body.error.code).toBe("not_member");
    expect((await lead(l, g, "lea")).body).toEqual({
      channel: g,
      leader: "lea",
      changed: false,
    });
    expect((await lead(n, g, "newt")).body.error.code).toBe("not_leader");
    const r = await lead(l, g, "newt");
    expect(r.body).toEqual({ channel: g, leader: "newt", changed: true });
    await bot("kay");
    expect((await invite(l, g, "kay")).body.error.code).toBe("not_leader");
    expect((await invite(n, g, "kay")).status).toBe(201);
    expect((await read(l, g)).body.channel.leader).toBe("newt");
    expect(await logged("channel.leader")).toHaveLength(1);
  });

  it("works from the connector: leave with channel, remove and new_leader", async () => {
    const { l, g } = await leaderWithGroup();
    const n = await bot("newt");
    const m = await bot("member");
    await bringIn(l, g, n);
    await bringIn(l, g, m);
    expect(
      (await tool(l.key, "leave", { channel: g, remove: "member" })).data
        .removed,
    ).toBe("member");
    expect(
      (await tool(l.key, "leave", { channel: g, new_leader: "newt" })).data
        .leader,
    ).toBe("newt");
    expect((await tool(l.key, "leave", { channel: g })).data.left).toBe(true);
    expect(
      (await tool(l.key, "leave", { with: "newt", remove: "x" })).isError,
    ).toBe(true);
    expect((await tool(l.key, "leave", {})).isError).toBe(true);
  });
});

describe("the database backs each rule", () => {
  it("refuses an invite without its bot, by a bot that doesn't lead, into a pair, or with its group changed", async () => {
    const { l, g } = await leaderWithGroup();
    const m = await bot("member");
    await bringIn(l, g, m);
    const id = Number(num(g));
    const ins = (maker: string, forBot: string | null, channel: number) => db()`
      INSERT INTO pairing_codes (bot_id, key_id, for_bot_id, channel_id, code_hash, expires_at)
      SELECT b.id, k.id, ${forBot === null ? null : db()`(SELECT id FROM bots WHERE handle = ${forBot})`}, ${channel},
             encode(sha256(random()::text::bytea), 'hex'), now() + interval '1 hour'
      FROM bots b JOIN api_keys k ON k.bot_id = b.id AND k.revoked_at IS NULL
      WHERE b.handle = ${maker}`;
    await bot("newt");
    await expect(ins("lea", null, id)).rejects.toThrow();
    await expect(ins("member", "newt", id)).rejects.toMatchObject(upr01);
    await ins("lea", "newt", id);
    const a = await bot("alpha");
    const code = (await tool(a.key, "invite", {})).data.code;
    await redeem(m, code);
    const [d] = await db()<
      { channel_id: string }[]
    >`SELECT channel_id FROM direct_channels`;
    await expect(
      ins("alpha", "newt", Number(d?.channel_id)),
    ).rejects.toMatchObject(upr01);
    await expect(
      db()`UPDATE pairing_codes SET channel_id = NULL WHERE channel_id IS NOT NULL`,
    ).rejects.toThrow();
  });

  it("refuses a member row without a maker, a person's tick or a redeemed invite for that bot", async () => {
    const { l, g } = await leaderWithGroup();
    const id = Number(num(g));
    const n = await bot("newt");
    const o = await bot("other");
    const newt = await idOf("newt");
    const lea = await idOf("lea");
    // A code join with no code, or with someone else's or an unused invite.
    await expect(
      db()`INSERT INTO channel_members (channel_id, bot_id, member, via, by_bot_id)
           VALUES (${id}, ${newt}, true, 'code', ${newt})`,
    ).rejects.toMatchObject(upr01);
    const forO = await invite(l, g, "other");
    await expect(
      db()`INSERT INTO channel_members (channel_id, bot_id, member, via, by_bot_id, pairing_code_id)
           VALUES (${id}, ${newt}, true, 'code', ${newt}, ${forO.body.invite.id})`,
    ).rejects.toMatchObject(upr01);
    const forN = await invite(l, g, "newt");
    await expect(
      db()`INSERT INTO channel_members (channel_id, bot_id, member, via, by_bot_id, pairing_code_id)
           VALUES (${id}, ${newt}, true, 'code', ${newt}, ${forN.body.invite.id})`,
    ).rejects.toMatchObject(upr01);
    // An ask join with no ask behind it.
    const h = await person("google-n", n);
    await db()`UPDATE pairing_codes SET redeemed_at = now(), redeemed_by_bot_id = ${newt} WHERE id = ${forN.body.invite.id}`;
    await expect(
      db()`INSERT INTO channel_members (channel_id, bot_id, member, via, by_human_id, pairing_code_id)
           VALUES (${id}, ${newt}, true, 'ask', ${h}, ${forN.body.invite.id})`,
    ).rejects.toMatchObject(upr01);
    // A second 'made' row, a 'made' row by another bot.
    await expect(
      db()`INSERT INTO channel_members (channel_id, bot_id, member, via, by_bot_id)
           VALUES (${id}, ${newt}, true, 'made', ${newt})`,
    ).rejects.toMatchObject(upr01);
    // The code row put in, then the same code used twice.
    await db()`INSERT INTO channel_members (channel_id, bot_id, member, via, by_bot_id, pairing_code_id)
               VALUES (${id}, ${newt}, true, 'code', ${newt}, ${forN.body.invite.id})`;
    // A 'left' row for another bot, a 'removed' row by a non-leader.
    await expect(
      db()`INSERT INTO channel_members (channel_id, bot_id, member, via, by_bot_id)
           VALUES (${id}, ${newt}, false, 'left', ${lea})`,
    ).rejects.toMatchObject(upr01);
    await expect(
      db()`INSERT INTO channel_members (channel_id, bot_id, member, via, by_bot_id)
           VALUES (${id}, ${lea}, false, 'removed', ${newt})`,
    ).rejects.toMatchObject(upr01);
    await db()`INSERT INTO channel_members (channel_id, bot_id, member, via, by_bot_id)
               VALUES (${id}, ${newt}, false, 'left', ${newt})`;
    await expect(
      db()`INSERT INTO channel_members (channel_id, bot_id, member, via, by_bot_id, pairing_code_id)
           VALUES (${id}, ${newt}, true, 'code', ${newt}, ${forN.body.invite.id})`,
    ).rejects.toThrow();
    void o;
  });

  it("keeps invites and memberships append-only", async () => {
    const { l, g } = await leaderWithGroup();
    await bot("newt");
    const inv = await invite(l, g, "newt");
    for (const q of [
      db()`UPDATE pairing_codes SET for_bot_id = NULL WHERE id = ${inv.body.invite.id}`,
      db()`DELETE FROM pairing_codes WHERE id = ${inv.body.invite.id}`,
      db()`UPDATE channel_members SET via = 'code'`,
      db()`DELETE FROM channel_members`,
    ])
      await expect(q).rejects.toThrow();
  });
});

describe("two writes at once", () => {
  it("an invite racing its leader's leaving leaves no live invite from a non-member", async () => {
    for (let round = 0; round < 3; round++) {
      await resetDb();
      const { l, g } = await leaderWithGroup();
      await bringIn(l, g, await bot("other"));
      await bot("newt");
      const [i, out] = await Promise.all([invite(l, g, "newt"), leave(l, g)]);
      expect(out.status).toBe(200);
      expect([201, 403, 404]).toContain(i.status);
      const [w] = await db()<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pairing_codes p
        WHERE p.channel_id IS NOT NULL AND channel_has(p.channel_id, p.bot_id)`;
      expect(w?.n).toBe(0);
    }
  });

  it("two invites at once both land", async () => {
    const { l, g } = await leaderWithGroup();
    await bot("newt");
    await bot("kay");
    const r = await Promise.all([
      invite(l, g, "newt"),
      invite(l, g, "kay"),
      invite(l, g, "newt"),
    ]);
    expect(r.map((x) => x.status)).toEqual([201, 201, 201]);
  });

  it("a join racing its person taking it out of the same group ends consistent", async () => {
    for (let round = 0; round < 3; round++) {
      await resetDb();
      const p = await bot("pal");
      const n = await bot("newt");
      await person("google-p", p, n);
      const q = await bot("qua");
      await person("google-p", q);
      const g = (
        await startChannel(db(), "google-p", ["pal", "qua"], "pal", null)
      ).channel;
      const inv = await invite(p, g, "newt");
      const [j, t] = await Promise.allSettled([
        redeem(n, inv.body.invite.code),
        setOwnBots(db(), "google-p", g, [], ["newt"], null),
      ]);
      expect(j.status).toBe("fulfilled");
      const inNow = (await members(g)).includes("newt");
      if (t.status === "fulfilled" && t.value.taken_out.includes("newt"))
        expect(inNow).toBe(false);
    }
  });

  it("a join racing its bot's release by its person ends consistent, without deadlock", async () => {
    for (let round = 0; round < 3; round++) {
      await resetDb();
      const { l, g } = await leaderWithGroup();
      const n = await bot("newt");
      await person("google-n", n);
      const m = await bot("mia");
      await bringIn(l, g, m);
      const inv = await invite(l, g, "newt");
      const [j, r, x] = await Promise.allSettled([
        redeem(n, inv.body.invite.code),
        releaseBot(db(), "google-n", "newt", null),
        leave(m, g),
      ]);
      expect(r.status).toBe("fulfilled");
      if (j.status !== "fulfilled" || x.status !== "fulfilled")
        throw new Error("a call threw");
      expect(j.value.status).toBe(200);
      expect(x.value.status).toBe(200);
      const [o] = await db()<{ owner_id: string | null }[]>`
        SELECT owner_id FROM bots WHERE handle = 'newt'`;
      expect(o?.owner_id).toBeNull();
      // In now only if it came in after the release took it out of its
      // groups: its newest row is the join.
      const [last] = await db()<{ via: string; member: boolean }[]>`
        SELECT via, member FROM channel_members
        WHERE channel_id = ${Number(num(g))} AND bot_id = ${await idOf("newt")}
        ORDER BY id DESC LIMIT 1`;
      expect((await members(g)).includes("newt")).toBe(last?.member === true);
      expect(last?.via).toBe(last?.member ? "code" : "release");
    }
  });

  it("approving racing redeeming the same invite joins once, without deadlock", async () => {
    for (let round = 0; round < 3; round++) {
      await resetDb();
      const { l, g } = await leaderWithGroup();
      const n = await bot("newt");
      await person("google-n", n);
      const inv = await invite(l, g, "newt");
      const [a, r] = await Promise.allSettled([
        approveAsk(db(), "google-n", inv.body.invite.id, null),
        redeem(n, inv.body.invite.code),
      ]);
      const wins =
        (a.status === "fulfilled" ? 1 : 0) +
        (r.status === "fulfilled" && r.value.status === 200 ? 1 : 0);
      expect(wins).toBe(1);
      const [c] = await db()<{ n: number }[]>`
        SELECT count(*)::int AS n FROM channel_members WHERE bot_id = ${await idOf("newt")}`;
      expect(c?.n).toBe(1);
    }
  });

  it("a block racing a join neither deadlocks nor joins a blocked pair", async () => {
    for (let round = 0; round < 3; round++) {
      await resetDb();
      const { l, g } = await leaderWithGroup();
      const n = await bot("newt");
      const inv = await invite(l, g, "newt");
      const [j, b] = await Promise.all([
        redeem(n, inv.body.invite.code),
        block(l, "newt"),
      ]);
      expect(b.status).toBeLessThan(300);
      expect([200, 400]).toContain(j.status);
      const [s] = await db()<
        { joined: boolean; blockedAt: Date; joinedAt: Date | null }[]
      >`
        SELECT EXISTS (SELECT 1 FROM channel_members WHERE bot_id = ${await idOf("newt")}) AS joined`;
      expect(s?.joined).toBe(j.status === 200);
    }
  });

  it("two joins at the member cap: one gets in, one hears the group is full", async () => {
    const { l, g } = await leaderWithGroup();
    for (let i = 0; i < GROUP_MEMBER_CAP - 2; i++)
      await bringIn(l, g, await bot(`mem${i}`));
    const x = await bot("exa");
    const y = await bot("why");
    const ix = await invite(l, g, "exa");
    const iy = await invite(l, g, "why");
    const r = await Promise.all([
      redeem(x, ix.body.invite.code),
      redeem(y, iy.body.invite.code),
    ]);
    expect(r.map((a) => a.status).sort()).toEqual([200, 409]);
    expect((await members(g)).length).toBe(GROUP_MEMBER_CAP);
  });

  it("two joins of one bot at its group cap: one gets in", async () => {
    const b = await bot("busy");
    await person("google-b", b);
    await inGroups("google-b", "busy", BOT_GROUP_CAP - 1);
    const { l, g } = await leaderWithGroup();
    const { l: k, g: h } = await leaderWithGroup("kit", "google-k");
    const i1 = await invite(l, g, "busy");
    const i2 = await invite(k, h, "busy");
    const r = await Promise.all([
      redeem(b, i1.body.invite.code),
      redeem(b, i2.body.invite.code),
    ]);
    expect(r.map((a) => a.status).sort()).toEqual([200, 409]);
    const [c] = await db()<
      { n: number }[]
    >`SELECT bot_groups(${await idOf("busy")}) AS n`;
    expect(c?.n).toBe(BOT_GROUP_CAP);
  });

  it("the trigger holds a bot's group cap under two adds at once from different groups", async () => {
    const b = await bot("busy");
    await person("google-b", b);
    await inGroups("google-b", "busy", BOT_GROUP_CAP - 1);
    const { l, g } = await leaderWithGroup();
    const { l: k, g: h } = await leaderWithGroup("kit", "google-k");
    const i1 = await invite(l, g, "busy");
    const i2 = await invite(k, h, "busy");
    const busy = await idOf("busy");
    for (const i of [i1, i2])
      await db()`UPDATE pairing_codes SET redeemed_at = now(), redeemed_by_bot_id = ${busy} WHERE id = ${i.body.invite.id}`;
    const add = (ch: string, code: number) =>
      db().begin(async (tx) => {
        await tx`SELECT lock_private_channel(${Number(num(ch))})`;
        await tx`SELECT pg_sleep(0.05)`;
        await tx`INSERT INTO channel_members (channel_id, bot_id, member, via, by_bot_id, pairing_code_id)
                 VALUES (${Number(num(ch))}, ${busy}, true, 'code', ${busy}, ${code})`;
      });
    const r = await Promise.allSettled([
      add(g, i1.body.invite.id),
      add(h, i2.body.invite.id),
    ]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const [c] = await db()<{ n: number }[]>`SELECT bot_groups(${busy}) AS n`;
    expect(c?.n).toBe(BOT_GROUP_CAP);
  });
});

// Every answer a bot gets from making, inviting, joining and leaving,
// walked for anything that says how a bot came in, who invited it, whose
// it is, or which bots share a person.
describe("what a bot learns", () => {
  function walk(v: unknown, path: string, out: string[]) {
    if (Array.isArray(v)) {
      for (const [i, x] of v.entries()) walk(x, `${path}[${i}]`, out);
    } else if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v)) {
        const p = `${path}.${k}`;
        if (
          /^by_|human|owner|from_message|since_id|person_id|invited_by/i.test(k)
        )
          out.push(p);
        // A bot sees how it came in itself, never how another did.
        if (k === "via" && !/^#\d+\.you\.via$/.test(p)) out.push(p);
        walk(x, p, out);
      }
    else if (typeof v === "string" && /human:\d|google-/.test(v))
      out.push(`${path}=${v}`);
  }

  it("tells a bot its leader invites into a person's group nothing of who started it or whose bots its members are", async () => {
    const a = await bot("ada");
    const b = await bot("bea");
    await person("google-p", a, b);
    const g = (
      await startChannel(db(), "google-p", ["ada", "bea"], "ada", null)
    ).channel;
    const s = await bot("sam");
    await person("google-s", s);
    const inv = await invite(a, g, "sam");
    const answers: unknown[] = [];
    answers.push((await call(digestRoute, { key: s.key })).body.asks);
    answers.push((await redeem(s, inv.body.invite.code)).body);
    answers.push((await read(s, g)).body);
    answers.push((await tool(s.key, "read_channel", { channel: g })).data);
    answers.push((await tool(s.key, "list_channels", {})).data.private);
    answers.push((await call(channelsRoute, { key: s.key })).body.private);
    const out: string[] = [];
    for (const [i, x] of answers.entries()) walk(x, `#${i}`, out);
    expect(out).toEqual([]);
    const text = JSON.stringify(answers);
    expect(text).not.toMatch(/your_person|same person|person's|started|yours/);
    expect((await read(s, g)).body.you).toEqual({
      via: "invited",
      lead: false,
    });
  });

  it("is handles, the leader and the bot's own codes", async () => {
    const l = await bot("lea");
    const mine = await bot("mine");
    await person("google-l", l, mine);
    const n = await bot("newt");
    await person("google-n", n);
    const answers: unknown[] = [];
    const m = await make(l);
    answers.push(m.body);
    const g = m.body.channel as string;
    const i1 = await invite(l, g, "mine");
    const i2 = await invite(l, g, "newt");
    answers.push(i1.body, i2.body);
    answers.push((await call(codesRoute, { key: l.key })).body);
    answers.push((await call(digestRoute, { key: mine.key })).body.asks);
    answers.push((await call(digestRoute, { key: n.key })).body.asks);
    answers.push((await redeem(mine, i1.body.invite.code)).body);
    await approveAsk(db(), "google-n", i2.body.invite.id, null);
    answers.push((await read(n, g)).body);
    answers.push((await read(l, g)).body);
    answers.push((await tool(n.key, "list_channels", {})).data.private);
    answers.push((await lead(l, g, "newt")).body);
    answers.push((await remove(n, g, "mine")).body);
    answers.push((await leave(l, g)).body);
    answers.push((await call(channelsRoute, { key: n.key })).body.private);
    const out: string[] = [];
    for (const [i, x] of answers.entries()) walk(x, `#${i}`, out);
    expect(out).toEqual([]);
    // Nothing tells newt that lea and mine share a person.
    expect(JSON.stringify(answers)).not.toMatch(/same person|your person's/);
  });
});

describe("what moderators see", () => {
  it("counts a bot's invites, joins and failed tries, and shows a group's history", async () => {
    const { l, g } = await leaderWithGroup();
    const n = await bot("newt");
    await bringIn(l, g, n);
    await redeem(n, "pair_aaaaaaaaaaaaaaaaaaaaaaaaaa");
    await leave(n, g);
    const lb = await lookupBot(db(), "lea");
    const nb = await lookupBot(db(), "newt");
    expect(lb?.groups).toMatchObject({ made: 1, invites_sent: 1 });
    expect(nb?.groups).toMatchObject({ joined: 1, left: 1 });
    const read = await readPrivateChannel(db(), Number(num(g)), "test");
    expect(JSON.stringify(read)).toMatch(/code/);
  });
});
