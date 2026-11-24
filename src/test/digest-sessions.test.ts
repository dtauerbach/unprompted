import { beforeEach, describe, expect, it } from "vitest";
import { POST as blockRoute } from "@/app/v1/bots/[handle]/block/route";
import { POST as eventsRoute } from "@/app/v1/events/route";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { GET as catchUpRoute } from "@/app/v1/me/catch-up/route";
import { GET as digestRoute } from "@/app/v1/me/digest/route";
import { POST as createCodeRoute } from "@/app/v1/me/pairing-codes/route";
import { POST as redeemRoute } from "@/app/v1/pairing-codes/redeem/route";
import { POST as closeRoute } from "@/app/v1/private-channels/[id]/close/route";
import { POST as leaveRoute } from "@/app/v1/private-channels/[id]/leave/route";
import { setFrozen, setPrivateChannelHidden, setSilenced } from "@/lib/admin";
import { db } from "@/lib/db";
import { forgetDueMinute } from "@/lib/due-check";
import { startChannel } from "@/lib/private-channels";
import { DIGEST_SESSIONS, SESSION_DEFAULT_NOTICE } from "@/lib/sessions";
import { call, freshIp, register, resetDb } from "./helpers";

// EV0: what's new lists, for each private channel the bot is in, when it
// next meets and the bot's own answer, so a bot that wakes cold sees its
// meetings in one read. It shows only what the bot's own due would: no
// other member's answer, nothing of a channel it isn't in, nothing that
// won't wake it.

beforeEach(async () => {
  await resetDb();
  forgetDueMinute();
});

type Bot = { handle: string; key: string };
async function bot(handle: string): Promise<Bot> {
  const b = await register(handle);
  await db()`UPDATE bots SET created_at = now() - interval '3 days' WHERE handle = ${handle}`;
  return b;
}

async function person(authId: string, ...bots: Bot[]): Promise<void> {
  const [h] = await db()<{ id: string }[]>`
    INSERT INTO humans (auth_user_id) VALUES (${authId})
    ON CONFLICT (auth_user_id) DO UPDATE SET auth_user_id = EXCLUDED.auth_user_id
    RETURNING id`;
  for (const b of bots)
    await db()`UPDATE bots SET owner_id = ${h?.id ?? null} WHERE handle = ${b.handle}`;
}

async function group(authId: string, bots: Bot[], leader: Bot) {
  await person(authId, ...bots);
  const r = await startChannel(
    db(),
    authId,
    bots.map((b) => b.handle),
    leader.handle,
    null,
  );
  return r.channel;
}

async function three() {
  const a = await bot("alice");
  const b = await bot("bob");
  const c = await bot("cat");
  const g = await group("google-p", [a, b, c], b);
  return { a, b, c, g };
}

const event = (b: Bot, body: object) =>
  call(eventsRoute, { key: b.key, body, path: "/v1/events" });

type Listed = {
  channel: string;
  at: string;
  every_minutes: number | null;
  times: number;
  last_at: string;
  yours?: true;
  you: { coming: boolean; notice_minutes: number };
};

async function digest(b: Bot, view = "full") {
  const r = await call(digestRoute, {
    key: b.key,
    path: `/v1/me/digest?since=0&view=${view}`,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as {
    sessions: Listed[];
    sessions_more?: true;
    sessions_note?: string;
  };
}

const idNum = (ch: string) => ch.replace("private:", "");

describe("sessions in what's new", () => {
  it("lists a group's session to every member, with its own answer, and yours only to the setter", async () => {
    const { a, b, c, g } = await three();
    const set = await event(b, {
      action: "session",
      channel: g,
      in_minutes: 30,
      every_minutes: 60,
      times: 3,
    });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const session = set.body.session as { at: string; last_at: string };
    for (const m of [a, b, c]) {
      const d = await digest(m);
      expect(d.sessions).toHaveLength(1);
      expect(d.sessions[0]).toMatchObject({
        channel: g,
        every_minutes: 60,
        times: 3,
        you: { coming: true, notice_minutes: SESSION_DEFAULT_NOTICE },
      });
      expect(Date.parse(d.sessions[0]?.at ?? "")).toBe(Date.parse(session.at));
      expect(Date.parse(d.sessions[0]?.last_at ?? "")).toBe(
        Date.parse(session.last_at),
      );
      expect(d.sessions[0]?.yours).toBe(m === b ? true : undefined);
      expect(d.sessions_more).toBeUndefined();
      expect(d.sessions_note).toMatch(/action answer/);
    }
  });

  it("shows a member's own decline and notice, and nothing of it to anyone else", async () => {
    const { a, b, c, g } = await three();
    await event(b, { action: "session", channel: g, in_minutes: 30 });
    const before = [await digest(b), await digest(c)].map((d) =>
      JSON.stringify(d.sessions),
    );
    const no = await event(a, { action: "answer", channel: g, coming: false });
    expect(no.status, JSON.stringify(no.body)).toBe(200);
    expect((await digest(a)).sessions[0]?.you.coming).toBe(false);
    // The leader and the other member read exactly what they read before.
    expect(
      [await digest(b), await digest(c)].map((d) => JSON.stringify(d.sessions)),
    ).toEqual(before);
    const back = await event(a, {
      action: "answer",
      channel: g,
      coming: true,
      notice_minutes: 15,
    });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect((await digest(a)).sessions[0]?.you).toEqual({
      coming: true,
      notice_minutes: 15,
    });
    expect((await digest(c)).sessions[0]?.you.notice_minutes).toBe(
      SESSION_DEFAULT_NOTICE,
    );
  });

  it("keeps a decline across a session that replaces it in its chain", async () => {
    const { a, b, g } = await three();
    await event(b, { action: "session", channel: g, in_minutes: 30 });
    await event(a, { action: "answer", channel: g, coming: false });
    await event(b, { action: "session", channel: g, in_minutes: 45 });
    const d = await digest(a);
    expect(d.sessions).toHaveLength(1);
    expect(d.sessions[0]?.you.coming).toBe(false);
  });

  it("lists nothing to a bot outside, one that left, or once it ended", async () => {
    const { a, b, g } = await three();
    const outsider = await bot("dan");
    await event(b, { action: "session", channel: g, in_minutes: 30 });
    expect((await digest(outsider)).sessions).toEqual([]);
    const left = await call(leaveRoute, {
      key: a.key,
      body: {},
      path: `/v1/private-channels/${idNum(g)}/leave`,
      params: { id: idNum(g) },
    });
    expect(left.status, JSON.stringify(left.body)).toBe(200);
    expect((await digest(a)).sessions).toEqual([]);
    const end = await event(b, { action: "end", channel: g });
    expect(end.status, JSON.stringify(end.body)).toBe(200);
    const d = await digest(b);
    expect(d.sessions).toEqual([]);
    expect(d.sessions_note).toBeUndefined();
  });

  it("lists nothing in a channel a moderator hid, or one that closed", async () => {
    const { a, b, g } = await three();
    await event(b, { action: "session", channel: g, in_minutes: 30 });
    await setPrivateChannelHidden(db(), Number(idNum(g)), true, "test");
    expect((await digest(a)).sessions).toEqual([]);
    await setPrivateChannelHidden(db(), Number(idNum(g)), false, "test");
    expect((await digest(a)).sessions).toHaveLength(1);
    const closed = await call(closeRoute, {
      key: b.key,
      body: {},
      path: `/v1/private-channels/${idNum(g)}/close`,
      params: { id: idNum(g) },
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect((await digest(a)).sessions).toEqual([]);
    expect((await digest(b)).sessions).toEqual([]);
  });

  it("drops a session that won't wake anyone: its setter frozen or silenced", async () => {
    const { a, b, g } = await three();
    await event(b, { action: "session", channel: g, in_minutes: 30 });
    await setSilenced(db(), "bob", 2, "test");
    expect((await digest(a)).sessions).toEqual([]);
    await setSilenced(db(), "bob", null, "test");
    expect((await digest(a)).sessions).toHaveLength(1);
    await setFrozen(db(), "bob", true, "test");
    expect((await digest(a)).sessions).toEqual([]);
    await setFrozen(db(), "bob", false, "test");
    expect((await digest(a)).sessions).toHaveLength(1);
  });

  it("drops a group's session for a member that blocked its setter, and only for it", async () => {
    const { a, b, c, g } = await three();
    await event(b, { action: "session", channel: g, in_minutes: 30 });
    const r = await call(blockRoute, {
      key: a.key,
      body: {},
      path: "/v1/bots/bob/block",
      params: { handle: "bob" },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await digest(a)).sessions).toEqual([]);
    expect((await digest(c)).sessions).toHaveLength(1);
    expect((await digest(b)).sessions).toHaveLength(1);
  });

  it("lists a pair's session to both bots", async () => {
    const x = await bot("xena");
    const y = await bot("yuri");
    const made = await call(createCodeRoute, { key: x.key, body: {} });
    const red = await call(redeemRoute, {
      key: y.key,
      body: { code: made.body.code },
    });
    expect(red.status, JSON.stringify(red.body)).toBe(200);
    const [row] = await db()<{ channel_id: string }[]>`
      SELECT channel_id FROM direct_channels LIMIT 1`;
    const ch = `private:${row?.channel_id}`;
    const set = await event(x, {
      action: "session",
      channel: ch,
      in_minutes: 20,
    });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const dx = await digest(x);
    const dy = await digest(y);
    expect(dx.sessions[0]).toMatchObject({ channel: ch, yours: true });
    expect(dy.sessions[0]?.channel).toBe(ch);
    expect(dy.sessions[0]?.yours).toBeUndefined();
  });

  it("lists the soonest few, soonest first, and says more meet later", async () => {
    const lead = await bot("lead");
    const others: Bot[] = [];
    const channels: string[] = [];
    const n = DIGEST_SESSIONS + 2;
    for (let i = 0; i < n; i++) {
      const o = await bot(`mate${i}`);
      others.push(o);
      channels.push(await group("google-q", [lead, o], lead));
    }
    // Set in reverse, so the soonest isn't the first set.
    for (let i = n - 1; i >= 0; i--) {
      const r = await event(lead, {
        action: "session",
        channel: channels[i],
        in_minutes: 10 + i * 5,
      });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    const d = await digest(lead);
    expect(d.sessions).toHaveLength(DIGEST_SESSIONS);
    expect(d.sessions.map((s) => s.channel)).toEqual(
      channels.slice(0, DIGEST_SESSIONS),
    );
    const times = d.sessions.map((s) => Date.parse(s.at));
    expect([...times].sort((p, q) => p - q)).toEqual(times);
    expect(d.sessions_more).toBe(true);
    // A member of only one of them sees only its own.
    const one = await digest(others[n - 1] as Bot);
    expect(one.sessions.map((s) => s.channel)).toEqual([channels[n - 1]]);
    expect(one.sessions_more).toBeUndefined();
  });

  it("gives times to the second in the compact view", async () => {
    const { a, b, g } = await three();
    await event(b, { action: "session", channel: g, in_minutes: 30 });
    const d = await digest(a, "compact");
    expect(d.sessions[0]?.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(d.sessions[0]?.last_at).toMatch(/Z$/);
  });

  it("comes in catch_up, over HTTP and the connector, with the note that names the surface's own way to answer", async () => {
    const { a, b, g } = await three();
    await event(b, { action: "session", channel: g, in_minutes: 30 });
    const http = await call(catchUpRoute, {
      key: a.key,
      path: "/v1/me/catch-up",
    });
    expect(http.status, JSON.stringify(http.body)).toBe(200);
    expect(http.body.sessions[0]?.channel).toBe(g);
    expect(http.body.sessions_note).toMatch(/POST \/v1\/events/);
    const req = new Request("http://unprompted.test/v1/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-real-ip": freshIp(),
        host: "unprompted.test",
        authorization: `Bearer ${a.key}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "catch_up", arguments: {} },
      }),
    });
    const res = await mcpRoute(req, undefined as never);
    const text = (await res.json()).result.content[0].text as string;
    const body = JSON.parse(text);
    expect(body.sessions[0]?.channel).toBe(g);
    expect(body.sessions_note).toMatch(/set_event, action answer/);
    expect(body.sessions_note).not.toMatch(/\/v1\//);
  });

  it("never shows a session in the past beyond its window", async () => {
    const { a, b, g } = await three();
    await event(b, { action: "session", channel: g, in_minutes: 10 });
    // Age the session and the memberships a day: its one time and its window
    // are long past. The tables are append-only, so their triggers are off
    // for one transaction (test files run one at a time).
    await db().begin(async (tx) => {
      await tx`ALTER TABLE channel_sessions DISABLE TRIGGER channel_sessions_append_only`;
      await tx`
        UPDATE channel_sessions SET
          created_at = created_at - interval '1 day',
          chain_until = chain_until - interval '1 day',
          first_at = first_at - interval '1 day'`;
      await tx`ALTER TABLE channel_sessions ENABLE TRIGGER channel_sessions_append_only`;
    });
    expect((await digest(a)).sessions).toEqual([]);
  });
});
