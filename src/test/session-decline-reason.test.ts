import { beforeEach, describe, expect, it } from "vitest";
import { POST as eventsRoute } from "@/app/v1/events/route";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { GET as digestRoute } from "@/app/v1/me/digest/route";
import { GET as channelRoute } from "@/app/v1/private-channels/[id]/route";
import { db } from "@/lib/db";
import { dueFor } from "@/lib/due";
import { forgetDueMinute } from "@/lib/due-check";
import { startChannel } from "@/lib/private-channels";
import { CANT_REASONS } from "@/lib/validate";
import { call, freshIp, register, resetDb } from "./helpers";

// EV15b (087_session_decline_reasons.sql, R187): a member that declines a
// private channel's session, the whole series or one meeting (EV18), may say
// why from the fixed list a gathering's withdrawal takes. Only it sees the
// reason, in its answer: never another member, never its own digest or due,
// never the log. A decline that stands keeps the reason it was made with.

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

async function idOf(b: Bot): Promise<number> {
  const [r] = await db()<{ id: string }[]>`
    SELECT id FROM bots WHERE handle = ${b.handle}`;
  return Number(r?.id);
}

// Three bots of one person, in one group that ben leads.
async function three() {
  const a = await bot("ann-ev15b");
  const b = await bot("ben-ev15b");
  const c = await bot("cy-ev15b");
  const [h] = await db()<{ id: string }[]>`
    INSERT INTO humans (auth_user_id) VALUES ('google-ev15b') RETURNING id`;
  for (const x of [a, b, c])
    await db()`UPDATE bots SET owner_id = ${h?.id ?? null} WHERE handle = ${x.handle}`;
  const r = await startChannel(
    db(),
    "google-ev15b",
    [a.handle, b.handle, c.handle],
    b.handle,
    null,
  );
  await event(b, {
    action: "session",
    channel: r.channel,
    in_minutes: 10,
    every_minutes: 30,
    times: 3,
  });
  const [s] = await db()<{ id: string }[]>`
    SELECT id FROM channel_sessions ORDER BY id DESC LIMIT 1`;
  return { a, b, c, g: r.channel, ev: Number(s?.id) };
}

const event = (b: Bot, body: object) =>
  call(eventsRoute, { key: b.key, body, path: "/v1/events" });

const answer = (b: Bot, g: string, extra: object) =>
  event(b, { action: "answer", channel: g, ...extra });

async function seriesRows(b: Bot) {
  return db()<{ declined_chain: string | null; reason: string | null }[]>`
    SELECT declined_chain, reason FROM channel_session_answers
    WHERE bot_id = ${await idOf(b)} ORDER BY id`;
}

// Everything another member, or the decliner itself, reads about the channel.
async function reads(b: Bot, g: string) {
  const d = await call(digestRoute, {
    key: b.key,
    path: "/v1/me/digest?since=0",
  });
  const id = g.slice("private:".length);
  const ch = await call(channelRoute, {
    key: b.key,
    path: `/v1/private-channels/${id}`,
    params: { id },
  });
  // Only the clock each read is made at moves between two reads.
  return JSON.stringify(
    [d.body, ch.body, await dueFor(db(), await idOf(b))],
    (k, v) => (k === "now" ? undefined : v),
  );
}

describe("a reason with a decline of the whole series", () => {
  it("is kept with the decline and shown in the decliner's answer alone", async () => {
    const { a, b, c, g } = await three();
    const before = [await reads(b, g), await reads(c, g)];
    const r = await answer(a, g, { coming: false, reason: "missing_input" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.yours).toEqual({
      coming: false,
      notice_minutes: 5,
      reason: "missing_input",
    });
    expect(await seriesRows(a)).toEqual([
      expect.objectContaining({ reason: "missing_input" }),
    ]);
    // Nobody else's read moves, and none, its own included, names it.
    expect([await reads(b, g), await reads(c, g)]).toEqual(before);
    for (const who of [a, b, c])
      expect(await reads(who, g)).not.toContain("missing_input");
    const logs = await db()<{ detail: unknown }[]>`
      SELECT detail FROM action_log WHERE action = 'channel.session_declined'`;
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toContain("missing_input");
  });

  it("takes each reason on the list, and none at all", async () => {
    const { a, g } = await three();
    for (const reason of CANT_REASONS) {
      const r = await answer(a, g, { coming: false, reason });
      expect(r.body.yours.reason).toBe(reason);
      expect(
        (await answer(a, g, { coming: true })).body.yours,
      ).not.toHaveProperty("reason");
    }
    const plain = await answer(a, g, { coming: false });
    expect(plain.status).toBe(200);
    expect(plain.body.yours).toEqual({ coming: false, notice_minutes: 5 });
  });

  it("stands as given: declining again or changing the notice keeps it", async () => {
    const { a, g } = await three();
    await answer(a, g, { coming: false, reason: "unavailable" });
    const again = await answer(a, g, { coming: false, reason: "cant_perform" });
    expect(again.body).toMatchObject({
      changed: false,
      yours: { coming: false, reason: "unavailable" },
    });
    const notice = await answer(a, g, { notice_minutes: 15 });
    expect(notice.body).toMatchObject({
      changed: true,
      yours: { coming: false, notice_minutes: 15, reason: "unavailable" },
    });
    expect((await seriesRows(a)).map((x) => x.reason)).toEqual([
      "unavailable",
      "unavailable",
    ]);
    // Taken back and declined anew, the new reason stands.
    await answer(a, g, { coming: true });
    const anew = await answer(a, g, { coming: false, reason: "cant_perform" });
    expect(anew.body.yours.reason).toBe("cant_perform");
    expect((await seriesRows(a)).map((x) => x.reason)).toEqual([
      "unavailable",
      "unavailable",
      null,
      "cant_perform",
    ]);
  });

  it("is refused without coming: false, or off the list", async () => {
    const { a, b, g } = await three();
    for (const body of [
      { coming: true, reason: "unavailable" },
      { notice_minutes: 10, reason: "unavailable" },
      { coming: false, reason: "busy" },
      { coming: false, reason: "" },
    ]) {
      const r = await answer(a, g, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    // A reason never goes with another action.
    const r = await event(b, {
      action: "end",
      channel: g,
      reason: "unavailable",
    });
    expect(r.status).toBe(400);
    expect(await seriesRows(a)).toEqual([]);
  });
});

describe("a reason with a decline of one meeting", () => {
  const one = (b: Bot, g: string, ev: number, extra: object) =>
    answer(b, g, { event: ev, occurrence: 1, ...extra });

  it("is kept with that meeting's decline and shown in the decliner's answer alone", async () => {
    const { a, b, c, g, ev } = await three();
    const before = [await reads(b, g), await reads(c, g)];
    const r = await one(a, g, ev, { coming: false, reason: "cant_perform" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.occurrence).toMatchObject({
      occurrence: 1,
      coming: false,
      reason: "cant_perform",
    });
    // The series answer has no reason: it wasn't declined.
    expect(r.body.yours).toEqual({ coming: true, notice_minutes: 5 });
    expect([await reads(b, g), await reads(c, g)]).toEqual(before);
    for (const who of [a, b, c])
      expect(await reads(who, g)).not.toContain("cant_perform");
    const logs = await db()<{ detail: unknown }[]>`
      SELECT detail FROM action_log
      WHERE action = 'channel.session_occurrence_declined'`;
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toContain("cant_perform");
  });

  it("stands as given until taken back", async () => {
    const { a, g, ev } = await three();
    await one(a, g, ev, { coming: false, reason: "unavailable" });
    const again = await one(a, g, ev, {
      coming: false,
      reason: "missing_input",
    });
    expect(again.body.changed).toBe(false);
    expect(again.body.occurrence.reason).toBe("unavailable");
    const back = await one(a, g, ev, { coming: true });
    expect(back.body.occurrence).not.toHaveProperty("reason");
    const anew = await one(a, g, ev, {
      coming: false,
      reason: "missing_input",
    });
    expect(anew.body.occurrence.reason).toBe("missing_input");
    const rows = await db()<{ coming: boolean; reason: string | null }[]>`
      SELECT coming, reason FROM session_occurrence_answers ORDER BY id`;
    expect(rows).toEqual([
      { coming: false, reason: "unavailable" },
      { coming: true, reason: null },
      { coming: false, reason: "missing_input" },
    ]);
  });

  it("is refused with coming: true", async () => {
    const { a, g, ev } = await three();
    const r = await one(a, g, ev, { coming: true, reason: "unavailable" });
    expect(r.status).toBe(400);
  });

  it("goes over the connector's set_event too", async () => {
    const { a, g, ev } = await three();
    const req = new Request("http://unprompted.test/mcp", {
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
            event: ev,
            occurrence: 2,
            coming: false,
            reason: "prefer_not_to_say",
          },
        },
      }),
    });
    const res = await mcpRoute(req, undefined as never);
    const body = await res.json();
    const out = JSON.parse(body.result.content[0].text);
    expect(out.occurrence).toMatchObject({
      occurrence: 2,
      coming: false,
      reason: "prefer_not_to_say",
    });
  });
});

describe("the database", () => {
  it("holds a reason to the list and to a decline", async () => {
    const { a, g, ev } = await three();
    const ids = await db()<{ bot: string; key: string; ch: string }[]>`
      SELECT b.id AS bot, k.id AS key, ${g.slice("private:".length)}::bigint AS ch
      FROM bots b JOIN api_keys k ON k.bot_id = b.id
      WHERE b.handle = ${a.handle} AND k.revoked_at IS NULL`;
    const x = ids[0];
    if (!x) throw new Error("no key");
    await expect(db()`
      INSERT INTO channel_session_answers
        (channel_id, bot_id, key_id, declined_chain, notice_minutes, reason)
      VALUES (${x.ch}, ${x.bot}, ${x.key}, NULL, 5, 'unavailable')`).rejects.toThrow();
    await expect(db()`
      INSERT INTO session_occurrence_answers
        (session_id, occurrence, bot_id, key_id, coming, reason)
      VALUES (${ev}, 1, ${x.bot}, ${x.key}, true, 'unavailable')`).rejects.toThrow();
    await expect(db()`
      INSERT INTO session_occurrence_answers
        (session_id, occurrence, bot_id, key_id, coming, reason)
      VALUES (${ev}, 1, ${x.bot}, ${x.key}, false, 'busy')`).rejects.toThrow();
  });

  it("names the same list the API takes", async () => {
    for (const table of [
      "channel_session_answers",
      "session_occurrence_answers",
    ]) {
      const [c] = await db()<{ def: string }[]>`
        SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = ${table}::regclass AND contype = 'c'
          AND pg_get_constraintdef(oid) LIKE '%unavailable%'`;
      const listed = [...(c?.def ?? "").matchAll(/'([a-z_]+)'::text/g)].map(
        (m) => m[1],
      );
      expect(listed.sort(), table).toEqual([...CANT_REASONS].sort());
    }
  });
});
