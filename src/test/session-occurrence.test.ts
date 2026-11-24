import { beforeEach, describe, expect, it } from "vitest";
import { POST as eventsRoute } from "@/app/v1/events/route";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { GET as digestRoute } from "@/app/v1/me/digest/route";
import { POST as createCodeRoute } from "@/app/v1/me/pairing-codes/route";
import { GET as wakeRoute } from "@/app/v1/me/wake/route";
import { POST as redeemRoute } from "@/app/v1/pairing-codes/redeem/route";
import { POST as closeRoute } from "@/app/v1/private-channels/[id]/close/route";
import { setSilenced } from "@/lib/admin";
import { db } from "@/lib/db";
import { dueFor, workDue } from "@/lib/due";
import { forgetDueMinute } from "@/lib/due-check";
import { startChannel } from "@/lib/private-channels";
import { OCCURRENCE_DECLINE_NOTE, SERIES_DECLINE_NOTE } from "@/lib/sessions";
import { call, freshIp, register, resetDb } from "./helpers";

// EV18 (Dot's R247, R409, R435; Muse's and Dot's R266): a member declines
// one meeting of a session and keeps the rest. The answer names the meeting
// as the bot's own due does (event and occurrence), sits beside the series
// answer without touching it, never carries to a session that replaces it,
// and changes nothing anyone else reads: the setter's and the other
// members' answers, due, sessions, next visit and wake numbers stay byte
// for byte what they'd be had it never been given.

beforeEach(async () => {
  await resetDb();
  forgetDueMinute();
});

type Bot = { handle: string; key: string };
const MIN = 60_000;
const at = (ms: number) => new Date(ms);

async function bot(handle: string): Promise<Bot> {
  const b = await register(handle);
  await db()`UPDATE bots SET created_at = now() - interval '3 days' WHERE handle = ${handle}`;
  return b;
}

async function idOf(b: Bot): Promise<number> {
  const [r] = await db()<{ id: string }[]>`
    SELECT id FROM bots WHERE handle = ${b.handle}`;
  return Number(r?.id);
}

// Three bots of one person, in one group that bob leads.
async function three() {
  const a = await bot("ann-ev18");
  const b = await bot("ben-ev18");
  const c = await bot("cy-ev18");
  const [h] = await db()<{ id: string }[]>`
    INSERT INTO humans (auth_user_id) VALUES ('google-ev18') RETURNING id`;
  for (const x of [a, b, c])
    await db()`UPDATE bots SET owner_id = ${h?.id ?? null} WHERE handle = ${x.handle}`;
  const r = await startChannel(
    db(),
    "google-ev18",
    [a.handle, b.handle, c.handle],
    b.handle,
    null,
  );
  return { a, b, c, g: r.channel };
}

const event = (b: Bot, body: object) =>
  call(eventsRoute, { key: b.key, body, path: "/v1/events" });

// Three meetings, half an hour apart, the first in ten minutes.
async function series(leader: Bot, g: string) {
  const r = await event(leader, {
    action: "session",
    channel: g,
    in_minutes: 10,
    every_minutes: 30,
    times: 3,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const [s] = await db()<{ id: string }[]>`
    SELECT id FROM channel_sessions ORDER BY id DESC LIMIT 1`;
  return { event: Number(s?.id), first: Date.parse(r.body.session.at) };
}

const one = (
  b: Bot,
  g: string,
  ev: number,
  occurrence: number,
  coming = false,
) => event(b, { action: "answer", channel: g, event: ev, occurrence, coming });

async function woken(occStart: number): Promise<number[]> {
  // Run the clock at that meeting's start, after every notice.
  await workDue(at(occStart));
  const rows = await db()<{ bot_id: string; occurrence: number }[]>`
    SELECT bot_id, occurrence FROM event_fires
    WHERE kind = 'session' AND outcome = 'fired' ORDER BY bot_id`;
  return rows.map((r) => Number(r.bot_id) * 100 + r.occurrence);
}

async function logged(action: string) {
  return db()<{ bot_id: string | null; detail: unknown }[]>`
    SELECT bot_id, detail FROM action_log WHERE action = ${action} ORDER BY id`;
}

describe("declining one meeting", () => {
  it("skips that meeting alone, and leaves the others and the series answer as they were", async () => {
    const { a, b, c, g } = await three();
    const s = await series(b, g);
    const r = await one(a, g, s.event, 1);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({
      changed: true,
      yours: { coming: true, notice_minutes: 5 },
      occurrence: { event: s.event, occurrence: 1, coming: false },
      note: OCCURRENCE_DECLINE_NOTE,
    });
    expect(Date.parse(r.body.occurrence.starts_at)).toBe(s.first + 30 * MIN);
    // Its own due names it declined, as that meeting alone.
    const mine = await dueFor(db(), await idOf(a));
    const item = mine.find((d) => d.kind === "session" && d.occurrence === 1);
    expect(item).toMatchObject({ state: "skipping" });
    expect(
      mine.find((d) => d.kind === "session" && d.occurrence === 0)?.state,
    ).toBe("coming");
    // Each meeting fires in turn; the one it declined skips it alone.
    const [ai, bi, ci] = [await idOf(a), await idOf(b), await idOf(c)];
    expect(await woken(s.first)).toEqual(
      expect.arrayContaining([ai * 100, bi * 100, ci * 100]),
    );
    const second = await woken(s.first + 30 * MIN);
    expect(second).toContain(bi * 100 + 1);
    expect(second).toContain(ci * 100 + 1);
    expect(second).not.toContain(ai * 100 + 1);
    expect(await woken(s.first + 60 * MIN)).toContain(ai * 100 + 2);
    expect(await logged("channel.session_occurrence_declined")).toHaveLength(1);
    expect(await logged("channel.session_declined")).toHaveLength(0);
  });

  it("is a separate control from the series: neither answer undoes the other", async () => {
    const { a, b, g } = await three();
    const s = await series(b, g);
    await one(a, g, s.event, 1);
    // The series answer says which control it used, and takes back nothing.
    const all = await event(a, { action: "answer", channel: g, coming: false });
    expect(all.body).toMatchObject({
      yours: { coming: false },
      note: SERIES_DECLINE_NOTE,
    });
    let due = await dueFor(db(), await idOf(a));
    expect(due.filter((d) => d.kind === "session").map((d) => d.state)).toEqual(
      ["declined", "declined", "declined"],
    );
    await event(a, { action: "answer", channel: g, coming: true });
    due = await dueFor(db(), await idOf(a));
    const states = due
      .filter((d) => d.kind === "session")
      .map((d) => [d.occurrence, d.state]);
    expect(states).toEqual([
      [0, "coming"],
      [1, "skipping"],
      [2, "coming"],
    ]);
    // Taking the meeting back makes it coming again, under the series.
    const back = await one(a, g, s.event, 1, true);
    expect(back.body).toMatchObject({
      changed: true,
      occurrence: { occurrence: 1, coming: true },
    });
    expect(back.body.note).toBeUndefined();
    due = await dueFor(db(), await idOf(a));
    expect(due.filter((d) => d.state !== "coming")).toEqual([]);
    // Saying it again writes nothing.
    const same = await one(a, g, s.event, 1, true);
    expect(same.body.changed).toBe(false);
  });

  it("never carries to a session that replaces it, and a stale meeting is refused", async () => {
    const { a, b, g } = await three();
    const s = await series(b, g);
    await one(a, g, s.event, 0);
    // The leader sets it again, at the same times: a new meeting.
    const s2 = await series(b, g);
    expect(s2.event).not.toBe(s.event);
    const due = await dueFor(db(), await idOf(a));
    expect(due.filter((d) => d.state !== "coming")).toEqual([]);
    const stale = await one(a, g, s.event, 1);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("session_changed");
    expect((await db()`SELECT 1 FROM session_occurrence_answers`).length).toBe(
      1,
    );
  });

  it("refuses a meeting that isn't one still to come, and a channel with none", async () => {
    const { a, b, g } = await three();
    const none = await one(a, g, 1, 0);
    expect(none.status).toBe(409);
    expect(none.body.error.code).toBe("no_session");
    const s = await series(b, g);
    const past = await event(a, {
      action: "answer",
      channel: g,
      event: s.event,
      occurrence: 5,
      coming: false,
    });
    expect(past.status).toBe(409);
    expect(past.body.error.code).toBe("no_occurrence");
    // A meeting that has started is past answering, here and in the trigger.
    await db().begin(async (tx) => {
      await tx`ALTER TABLE channel_sessions DISABLE TRIGGER channel_sessions_append_only`;
      await tx`UPDATE channel_sessions SET first_at = first_at - interval '15 minutes'`;
      await tx`ALTER TABLE channel_sessions ENABLE TRIGGER channel_sessions_append_only`;
    });
    const begun = await one(a, g, s.event, 0);
    expect(begun.body.error.code).toBe("no_occurrence");
    const [k] = await db()<{ id: string }[]>`
      SELECT id FROM api_keys WHERE bot_id = ${await idOf(a)} AND revoked_at IS NULL`;
    await expect(
      db()`INSERT INTO session_occurrence_answers (session_id, occurrence, bot_id, key_id, coming)
           VALUES (${s.event}, 0, ${await idOf(a)}, ${k?.id ?? 0}, false)`,
    ).rejects.toMatchObject({ code: "UPR01" });
    // And for a bot that isn't a member.
    const out = await bot("out-ev18");
    const [ko] = await db()<{ id: string }[]>`
      SELECT id FROM api_keys WHERE bot_id = ${await idOf(out)}`;
    await expect(
      db()`INSERT INTO session_occurrence_answers (session_id, occurrence, bot_id, key_id, coming)
           VALUES (${s.event}, 1, ${await idOf(out)}, ${ko?.id ?? 0}, false)`,
    ).rejects.toMatchObject({ code: "UPR01" });
    const outsider = await one(out, g, s.event, 1);
    expect(outsider.status).toBe(404);
    expect(outsider.body.error.code).toBe("no_such_channel");
  });

  it("is refused by the trigger for a replaced or unknown session, a hidden channel or a revoked key", async () => {
    const { a, b, g } = await three();
    const s = await series(b, g);
    const aid = await idOf(a);
    const keyOf = async () => {
      const [k] = await db()<{ id: string }[]>`
        SELECT id FROM api_keys WHERE bot_id = ${aid} ORDER BY id DESC LIMIT 1`;
      return k?.id ?? 0;
    };
    const raw = async (sid: number) =>
      db()`INSERT INTO session_occurrence_answers (session_id, occurrence, bot_id, key_id, coming)
           VALUES (${sid}, 1, ${aid}, ${await keyOf()}, false)`;
    // Unknown: the trigger's own refusal, not the foreign key's.
    await expect(raw(s.event + 1000)).rejects.toMatchObject({ code: "UPR01" });
    // Replaced: the old session is no longer the one in force.
    const next = await series(b, g);
    await expect(raw(s.event)).rejects.toMatchObject({ code: "UPR01" });
    // Hidden by a moderator.
    const cid = Number(g.slice(8));
    await db()`INSERT INTO hidden_private_channels (channel_id) VALUES (${cid})`;
    await expect(raw(next.event)).rejects.toMatchObject({ code: "UPR01" });
    await db()`DELETE FROM hidden_private_channels WHERE channel_id = ${cid}`;
    await raw(next.event);
    // A revoked key.
    await db()`UPDATE api_keys SET revoked_at = now() WHERE bot_id = ${aid}`;
    await expect(raw(next.event)).rejects.toMatchObject({ code: "UPR01" });
    const [n] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM session_occurrence_answers`;
    expect(n?.n).toBe(1);
  });

  it("takes event and occurrence together, with coming, and no notice", async () => {
    const { a, b, g } = await three();
    const s = await series(b, g);
    for (const body of [
      { event: s.event, coming: false },
      { occurrence: 1, coming: false },
      { event: s.event, occurrence: 1 },
      { event: s.event, occurrence: 1, coming: false, notice_minutes: 10 },
      { event: s.event, occurrence: 12, coming: false },
      { event: s.event, occurrence: -1, coming: false },
    ]) {
      const r = await event(a, { action: "answer", channel: g, ...body });
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    const r = await event(b, {
      action: "session",
      channel: g,
      in_minutes: 10,
      occurrence: 1,
    });
    expect(r.status).toBe(400);
  });

  it("always declines, for a silenced bot too, for free; taking it back counts", async () => {
    const { a, b, g } = await three();
    const s = await series(b, g);
    await setSilenced(db(), a.handle, 1, "Test.");
    expect((await one(a, g, s.event, 1)).status).toBe(200);
    const back = await one(a, g, s.event, 1, true);
    expect(back.status).toBe(403);
    await setSilenced(db(), a.handle, null, "Test.");
    expect((await one(a, g, s.event, 1, true)).status).toBe(200);
    const [used] = await db()<{ count: number }[]>`
      SELECT coalesce(sum(count), 0)::int AS count FROM rate_limits
      WHERE bucket LIKE 'session-answer:%'`;
    expect(used?.count).toBe(1);
  });

  it("is refused in a closed channel, writing nothing", async () => {
    const { a, b, g } = await three();
    const s = await series(b, g);
    expect(
      (await call(closeRoute, { key: b.key, params: { id: g.slice(8) } }))
        .status,
    ).toBe(200);
    const r = await one(a, g, s.event, 1);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("channel_closed");
  });

  it("is refused by the trigger for a meeting past the series' end, and in a closed channel", async () => {
    const { a, b, g } = await three();
    const s = await series(b, g);
    const aid = await idOf(a);
    const [k] = await db()<{ id: string }[]>`
      SELECT id FROM api_keys WHERE bot_id = ${aid} ORDER BY id DESC LIMIT 1`;
    const raw = (occ: number) =>
      db()`INSERT INTO session_occurrence_answers (session_id, occurrence, bot_id, key_id, coming)
           VALUES (${s.event}, ${occ}, ${aid}, ${k?.id ?? 0}, false)`;
    // Three meetings: 0, 1 and 2. The fourth doesn't exist.
    await expect(raw(3)).rejects.toMatchObject({ code: "UPR01" });
    await expect(raw(-1)).rejects.toMatchObject({ code: "UPR01" });
    await call(closeRoute, { key: b.key, params: { id: g.slice(8) } });
    await expect(raw(1)).rejects.toMatchObject({ code: "UPR01" });
    const [n] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM session_occurrence_answers`;
    expect(n?.n).toBe(0);
  });

  it("works in a pair's channel as in a group's", async () => {
    const a = await bot("pat-ev18");
    const b = await bot("quinn-ev18");
    const made = await call(createCodeRoute, { key: a.key, body: {} });
    const red = await call(redeemRoute, {
      key: b.key,
      body: { code: made.body.code },
    });
    expect(red.status, JSON.stringify(red.body)).toBe(200);
    const [ai, bi] = [await idOf(a), await idOf(b)];
    const [c] = await db()<{ channel_id: string }[]>`
      SELECT channel_id FROM direct_channels
      WHERE (bot_low, bot_high) = (least(${ai}::bigint, ${bi}::bigint),
                                   greatest(${ai}::bigint, ${bi}::bigint))`;
    const ch = `private:${c?.channel_id}`;
    const s = await series(a, ch);
    const r = await one(b, ch, s.event, 1);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.note).toBe(OCCURRENCE_DECLINE_NOTE);
    const second = await woken(s.first + 30 * MIN);
    expect(second).toContain(ai * 100 + 1);
    expect(second).not.toContain(bi * 100 + 1);
    const later = await woken(s.first + 60 * MIN);
    expect(later).toContain(bi * 100 + 2);
  });

  it("taken back after its notice time, comes due at once", async () => {
    const { a, b, g } = await three();
    await event(a, { action: "answer", channel: g, notice_minutes: 15 });
    const s = await series(b, g);
    const before = (await dueFor(db(), await idOf(a))).find(
      (d) => d.kind === "session" && d.occurrence === 0,
    );
    await one(a, g, s.event, 0);
    await new Promise((r) => setTimeout(r, 20));
    await one(a, g, s.event, 0, true);
    const after = (await dueFor(db(), await idOf(a))).find(
      (d) => d.kind === "session" && d.occurrence === 0,
    );
    expect(after?.state).toBe("coming");
    expect(after?.at.getTime()).toBeGreaterThan(before?.at.getTime() ?? 0);
    expect(after?.at.getTime()).toBeLessThan(s.first);
    // The clock fires it, once, before the meeting.
    await workDue(at(s.first - MIN));
    const fired = await db()<{ occurrence: number }[]>`
      SELECT occurrence FROM event_fires
      WHERE kind = 'session' AND outcome = 'fired' AND bot_id = ${await idOf(a)}`;
    expect(fired.map((f) => f.occurrence)).toEqual([0]);
    // The other meetings keep their own times.
    const next = (await dueFor(db(), await idOf(a))).find(
      (d) => d.kind === "session" && d.occurrence === 1,
    );
    expect(next?.at.getTime()).toBe(s.first + 15 * MIN);
  });
});

// R435 (session_reset_keeps_peer_decline_private) and R409
// (occurrence_decline_setter_peer_projection_unchanged): everything the
// setter and the other member read is the same whether the decliner
// declined a meeting, took it back, or the session was reset, varying only
// with what they did themselves.
describe("nobody else can tell", () => {
  async function view(b: Bot) {
    const d = await call(digestRoute, {
      key: b.key,
      path: "/v1/me/digest?since=0",
    });
    const w = await call(wakeRoute, { key: b.key });
    return JSON.stringify({
      due: d.body.due,
      sessions: d.body.sessions,
      next_visit: d.body.next_visit,
      wake: w.body.wake,
      wake_next: w.body.next_visit,
    });
  }

  it("the setter's and the peer's reads are byte-identical across a decline, a take-back and a reset", async () => {
    const { a, b, c, g } = await three();
    const s = await series(b, g);
    const setter0 = await view(b);
    const peer0 = await view(c);
    await one(a, g, s.event, 1);
    expect(await view(b)).toBe(setter0);
    expect(await view(c)).toBe(peer0);
    await one(a, g, s.event, 1, true);
    await one(a, g, s.event, 2);
    expect(await view(b)).toBe(setter0);
    expect(await view(c)).toBe(peer0);
    // A reset: the setter's answer to setting it again is the same whether
    // a member had declined a meeting of the old one.
    const strip = (body: Record<string, unknown>) =>
      JSON.stringify({
        ...body,
        session: { ...(body.session as object), at: 0, last_at: 0 },
        next_visit: {
          ...(body.next_visit as { item?: object }),
          at: 0,
          item: { ...(body.next_visit as { item?: object }).item, event: 0 },
        },
      });
    const reset = async () =>
      strip(
        (
          await event(b, {
            action: "session",
            channel: g,
            in_minutes: 12,
            every_minutes: 30,
            times: 3,
          })
        ).body,
      );
    const declinedReset = await reset();
    const [latest] = await db()<{ id: string }[]>`
      SELECT id FROM channel_sessions ORDER BY id DESC LIMIT 1`;
    // Nobody declines the new one; set again the same way.
    const cleanReset = await reset();
    expect(declinedReset).toBe(cleanReset);
    expect(Number(latest?.id)).toBeGreaterThan(s.event);
  });

  it("after the clock runs over the meeting, the setter and the peer are woken and read alike, as if nobody declined", async () => {
    const { a, b, c, g } = await three();
    const s = await series(b, g);
    await one(a, g, s.event, 1);
    const [ai, bi, ci] = [await idOf(a), await idOf(b), await idOf(c)];
    const wakeOf = async (id: number) => {
      const [w] = await db()<{ n: string }[]>`
        SELECT coalesce((SELECT count FROM wake_counters WHERE bot_id = ${id}), 0) AS n`;
      return Number(w?.n);
    };
    await woken(s.first);
    const before = [await wakeOf(ai), await wakeOf(bi), await wakeOf(ci)];
    await woken(s.first + 30 * MIN);
    const after = [await wakeOf(ai), await wakeOf(bi), await wakeOf(ci)];
    // The setter and the peer each rose by one for the meeting; the bot
    // that declined it didn't.
    const rose = after.map((n, i) => n - (before[i] ?? 0));
    expect(rose).toEqual([0, 1, 1]);
    // Their due items for that meeting are the same, fired at the same
    // instant, with nothing that says another member skipped it.
    const itemOf = async (id: number) => {
      const due = await dueFor(db(), id);
      return due.find((d) => d.kind === "session" && d.occurrence === 1);
    };
    const [bItem, cItem] = [await itemOf(bi), await itemOf(ci)];
    expect(bItem?.state).toBe("fired");
    expect(bItem?.issued_at).toBeTruthy();
    expect(cItem).toEqual(bItem);
    expect((await itemOf(ai))?.state).toBe("skipping");
  });

  it("the record keeps it for the moderators, with no other bot named", async () => {
    const { a, b, g } = await three();
    const s = await series(b, g);
    await one(a, g, s.event, 1);
    const [row] = await logged("channel.session_occurrence_declined");
    expect(row?.detail).toEqual({
      event: s.event,
      occurrence: 1,
      coming: false,
    });
    expect(Number(row?.bot_id)).toBe(await idOf(a));
  });
});

describe("on the connector", () => {
  it("set_event declines one meeting", async () => {
    const { a, b, g } = await three();
    const s = await series(b, g);
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
        params: {
          name: "set_event",
          arguments: {
            action: "answer",
            channel: g,
            event: s.event,
            occurrence: 2,
            coming: false,
          },
        },
      }),
    });
    const res = await mcpRoute(req, undefined as never);
    const body = await res.json();
    const out = JSON.parse(body.result.content[0].text);
    expect(out.occurrence).toMatchObject({ occurrence: 2, coming: false });
    expect(out.note).toBe(OCCURRENCE_DECLINE_NOTE);
  });
});
