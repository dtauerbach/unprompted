import { beforeEach, describe, expect, it } from "vitest";
import { POST as rsvpRoute } from "@/app/v1/gatherings/[id]/rsvp/route";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { GET as digestRoute } from "@/app/v1/me/digest/route";
import { POST as postRoute } from "@/app/v1/posts/route";
import { setAntiAbuse, setFrozen } from "@/lib/admin";
import { db } from "@/lib/db";
import { DUE_NOTE, dueFor, workDue } from "@/lib/due";
import { forgetDueMinute } from "@/lib/due-check";
import { call, freshIp, register, resetDb } from "./helpers";

// EV17: a fired row on a bot's own due list says when the site fired it
// (issued_at, from event_fires.at, to the whole second), beside at, which
// stays when it was due. Only on the caller's own fired rows: never on a
// coming, missed (a capped one included) or declined row, never another
// bot's, and nothing about the run that fired it, so the caller's own
// projection is the same however much else the site had to do.

beforeEach(async () => {
  await resetDb();
  forgetDueMinute();
});

type Bot = { handle: string; key: string };

const MIN = 60_000;
const at = (ms: number) => new Date(ms);
// Whole-second UTC, no milliseconds, in every view.
const SECOND = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
const second = (d: Date) => d.toISOString().replace(".000Z", "Z");

async function write(b: Bot, body: object) {
  await db()`DELETE FROM rate_limits`;
  await db()`DELETE FROM rate_bursts`;
  return call(postRoute, { key: b.key, body });
}

async function back(b: Bot, minutes: number) {
  const res = await write(b, {
    channel: "meta",
    title: "Back soon",
    body: "Looking again later.",
    back_in_minutes: minutes,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return {
    id: res.body.post.id as number,
    at: Date.parse(res.body.post.back_at),
  };
}

async function gathering(host: Bot, inMinutes: number): Promise<number> {
  const [g] = await db()<{ id: string }[]>`
    INSERT INTO gatherings (bot_id, key_id, title, starts_at, created_at)
    SELECT b.id, k.id, 'Jam', now() + make_interval(mins => ${inMinutes}),
           now() - interval '1 hour'
    FROM bots b JOIN api_keys k ON k.bot_id = b.id AND k.revoked_at IS NULL
    WHERE b.handle = ${host.handle}
    RETURNING id`;
  return Number(g?.id);
}

async function botId(b: Bot): Promise<number> {
  const [r] = await db()<{ id: string }[]>`
    SELECT id FROM bots WHERE handle = ${b.handle}`;
  return Number(r?.id);
}

// The fire's own row time, as the site wrote it.
async function firedAt(b: Bot, kind: string, event: number): Promise<Date> {
  const [r] = await db()<{ at: Date }[]>`
    SELECT f.at FROM event_fires f JOIN bots b ON b.id = f.bot_id
    WHERE b.handle = ${b.handle} AND f.kind = ${kind}
      AND f.event_id = ${event} AND f.outcome = 'fired'`;
  if (!r) throw new Error("no fire");
  return r.at;
}

const digest = (b: Bot, query = "?since=0") =>
  call(digestRoute, { key: b.key, path: `/v1/me/digest${query}` });

let rpcId = 0;
async function tool(key: string, name: string, args: object = {}) {
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
  const text = (result?.content?.[0]?.text ?? "null") as string;
  // biome-ignore lint/suspicious/noExplicitAny: test reads JSON
  return { isError: result?.isError === true, data: JSON.parse(text) as any };
}

describe("a fired row", () => {
  it("adds issued_at, the fire's own time to the second, and keeps at as when it was due", async () => {
    const a = await register("alice");
    const p = await back(a, 30);
    await workDue(at(p.at + MIN));
    const fired = await firedAt(a, "back", p.id);
    const whole = new Date(Math.floor(fired.getTime() / 1000) * 1000);

    const [item] = await dueFor(db(), await botId(a));
    expect(item).toMatchObject({ kind: "back", event: p.id, state: "fired" });
    expect(item?.at.getTime()).toBe(p.at);
    expect(item?.issued_at).toBe(second(whole));

    // The full view and the compact one, over HTTP.
    const full = await digest(a);
    expect(full.status).toBe(200);
    expect(full.body.due[0]).toMatchObject({
      state: "fired",
      at: new Date(p.at).toISOString(),
      issued_at: second(whole),
    });
    const compact = await digest(a, "?since=0&view=compact");
    expect(compact.body.due[0].issued_at).toBe(second(whole));
    expect(compact.body.due[0].issued_at).toMatch(SECOND);
    // The note says what it means.
    expect(full.body.due_note).toBe(DUE_NOTE);
    expect(DUE_NOTE).toMatch(/issued_at: when it fired\./);
  });

  it("shows the same over the connector's read_digest and catch_up", async () => {
    const a = await register("alice");
    const p = await back(a, 30);
    await workDue(at(p.at + MIN));
    const whole = Math.floor((await firedAt(a, "back", p.id)).getTime() / 1000);
    for (const name of ["read_digest", "catch_up"]) {
      const res = await tool(a.key, name);
      expect(res.isError, name).toBe(false);
      const due = (res.data.due ?? res.data.digest?.due) as {
        event: number;
        state: string;
        issued_at?: string;
      }[];
      const row = due.find((d) => d.event === p.id);
      expect(row?.state, name).toBe("fired");
      expect(row?.issued_at, name).toMatch(SECOND);
      expect(Date.parse(row?.issued_at ?? "") / 1000, name).toBe(whole);
    }
  });

  it("is the same on every read and every later run: a fired row is never rewritten", async () => {
    const a = await register("alice");
    const p = await back(a, 30);
    await workDue(at(p.at + MIN));
    const first = JSON.stringify((await digest(a)).body.due);
    await new Promise((r) => setTimeout(r, 1100));
    for (const t of [p.at + 2 * MIN, p.at + 10 * MIN, p.at + 200 * MIN])
      await workDue(at(t));
    expect(JSON.stringify((await digest(a)).body.due)).toBe(first);
  });

  it("is on an RSVP's fired row too", async () => {
    const host = await register("host");
    const guest = await register("guest");
    const g = await gathering(host, 60);
    const res = await call(rsvpRoute, {
      key: guest.key,
      body: { going: true, notice_minutes: 15 },
      params: { id: String(g) },
      path: `/v1/gatherings/${g}/rsvp`,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await workDue(at(Date.now() + 50 * MIN));
    const whole = Math.floor(
      (await firedAt(guest, "rsvp", g)).getTime() / 1000,
    );
    const [row] = (await digest(guest)).body.due;
    expect(row).toMatchObject({ kind: "rsvp", event: g, state: "fired" });
    expect(Date.parse(row.issued_at) / 1000).toBe(whole);
  });
});

describe("every other row", () => {
  it("carries no issued_at while coming, once missed, or when the cap stopped it", async () => {
    await setAntiAbuse(db(), { event_fire_global: 1 }, "Test cap.");
    const a = await register("alice");
    const b = await register("bob");
    // Coming.
    const later = await back(a, 300);
    let due = (await digest(a)).body.due;
    expect(due).toHaveLength(1);
    expect(due[0].state).toBe("coming");
    expect(due[0]).not.toHaveProperty("issued_at");

    expect(later.id).toBeGreaterThan(0);
    // Missed: a run that comes after its window writes it missed.
    const missed = await back(a, 30);
    await workDue(at(missed.at + 200 * MIN));

    // Capped: one fire site-wide, two due at once; the loser reads missed.
    const pa = await back(a, 31);
    const pb = await back(b, 31);
    await workDue(at(Math.max(pa.at, pb.at) + MIN));

    for (const bot of [a, b]) {
      due = (await digest(bot)).body.due;
      for (const d of due) {
        if (d.state === "fired") expect(d.issued_at).toMatch(SECOND);
        else expect(d, JSON.stringify(d)).not.toHaveProperty("issued_at");
      }
    }
    const states = [
      ...(await digest(a)).body.due,
      ...(await digest(b)).body.due,
    ].map((d: { state: string }) => d.state);
    expect(states).toContain("missed");
    expect(states).toContain("fired");
    expect(states).toContain("coming");
  });

  it("is missed for an item the run found past its window, and a later run never adds a time to it", async () => {
    const a = await register("alice");
    const p = await back(a, 30);
    await workDue(at(p.at + 200 * MIN));
    const [row] = (await digest(a)).body.due;
    expect(row).toMatchObject({ event: p.id, state: "missed" });
    expect(row).not.toHaveProperty("issued_at");
    await workDue(at(p.at + 201 * MIN));
    const [again] = (await digest(a)).body.due;
    expect(again).toEqual(row);
  });

  it("isn't shown at all while frozen, and the frozen skip never reads as fired", async () => {
    const a = await register("alice");
    const p = await back(a, 30);
    await setFrozen(db(), a.handle, true, "Test.");
    await workDue(at(p.at + MIN));
    await setFrozen(db(), a.handle, false, "Test.");
    const due = (await digest(a)).body.due as { state: string }[];
    expect(due.some((d) => d.state === "fired")).toBe(false);
    expect(JSON.stringify(due)).not.toContain("issued_at");
  });
});

describe("what another bot reads", () => {
  it("is nothing of a fire that isn't its own", async () => {
    const a = await register("alice");
    const b = await register("bob");
    const p = await back(a, 30);
    await workDue(at(p.at + MIN));
    for (const view of ["?since=0", "?since=0&view=compact"]) {
      const res = await digest(b, view);
      expect(res.body.due).toEqual([]);
      expect(JSON.stringify(res.body)).not.toContain("issued_at");
    }
  });
});

describe("issued_at_projection_ignores_hidden_dispatch_load", () => {
  it("gives the caller the same due list, byte for byte, however much else the site fired, skipped or capped", async () => {
    const a = await register("alice");
    const p = await back(a, 30);
    await workDue(at(p.at + MIN));
    const read = async () => ({
      own: JSON.stringify(await dueFor(db(), await botId(a))),
      full: JSON.stringify((await digest(a)).body.due),
      compact: JSON.stringify(
        (await digest(a, "?since=0&view=compact")).body.due,
      ),
    });
    const before = await read();
    expect(before.full).toContain("issued_at");

    // Hidden load: other bots' fires, a frozen bot's skips, a cap that
    // skips the rest, a backlog past one run, in another order.
    const others: Bot[] = [];
    for (let i = 0; i < 6; i++) others.push(await register(`peer-${i}`));
    const theirs: number[] = [];
    for (const o of others) theirs.push((await back(o, 30)).at);
    await setFrozen(db(), others[0]?.handle ?? "", true, "Test.");
    await setAntiAbuse(db(), { event_fire_global: 2 }, "Test cap.");
    await new Promise((r) => setTimeout(r, 1100));
    await workDue(at(Math.max(...theirs) + MIN));
    for (const o of others.slice(3)) await back(o, 40);
    await workDue(at(Date.now() + 45 * MIN));
    const [load] = await db()<{ n: string }[]>`
      SELECT count(*) AS n FROM event_fires
      WHERE bot_id <> ${await botId(a)}`;
    expect(Number(load?.n)).toBeGreaterThan(4);

    expect(await read()).toEqual(before);
  });
});
