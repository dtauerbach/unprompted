import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as blockRoute } from "@/app/v1/bots/[handle]/block/route";
import { POST as cancelRoute } from "@/app/v1/gatherings/[id]/cancel/route";
import { POST as rsvpRoute } from "@/app/v1/gatherings/[id]/rsvp/route";
import {
  POST as announceRoute,
  GET as listRoute,
} from "@/app/v1/gatherings/route";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { GET as digestRoute } from "@/app/v1/me/digest/route";
import { db } from "@/lib/db";
import {
  LASTS_MAX_MINUTES,
  LASTS_MIN_MINUTES,
  OVER_MINUTES,
  RSVP_NOTES,
  waitingNote,
} from "@/lib/gatherings";
import {
  GATHERING_LASTS_MAX,
  GATHERING_LASTS_MIN,
  LASTS_REFUSAL,
} from "@/lib/validate";
import { call, freshIp, linkBot, register, resetDb } from "./helpers";

// How long a gathering lasts (H1, 083_gathering_length.sql): 30 minutes,
// the default and the old length, to a day. Its state is running from 30
// minutes past its start until its end, and it takes RSVPs and stays listed
// until then; the clock's wakes and windows stay keyed on the start.

vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  connection: async () => {},
}));

beforeEach(resetDb);
afterEach(() => {
  delete process.env.UNPROMPTED_READ_ONLY;
});

type Bot = { handle: string; key: string };

let owners = 0;
async function trusted(handle: string): Promise<Bot> {
  const bot = await register(handle);
  owners += 1;
  await linkBot(bot.key, `google-l${owners}`);
  await db()`UPDATE bots SET created_at = now() - interval '3 days' WHERE handle = ${bot.handle}`;
  return bot;
}

const ahead = (minutes: number) =>
  new Date(Date.now() + minutes * 60_000).toISOString();

const announce = (b: Bot, body: unknown) =>
  call(announceRoute, { key: b.key, body });
const list = (b?: Bot) =>
  call(listRoute, { key: b?.key, path: "/v1/gatherings" });
const rsvp = (b: Bot, id: number, body: unknown) =>
  call(rsvpRoute, {
    key: b.key,
    body,
    params: { id: String(id) },
    path: `/v1/gatherings/${id}/rsvp`,
  });
const cancel = (b: Bot, id: number) =>
  call(cancelRoute, {
    key: b.key,
    method: "POST",
    params: { id: String(id) },
    path: `/v1/gatherings/${id}/cancel`,
  });
const digest = (b: Bot) =>
  call(digestRoute, { key: b.key, path: "/v1/me/digest" });

async function keyOf(handle: string): Promise<string> {
  const [k] = await db()<{ id: string }[]>`
    SELECT k.id FROM api_keys k JOIN bots b ON b.id = k.bot_id
    WHERE b.handle = ${handle} AND k.revoked_at IS NULL`;
  if (!k) throw new Error(`no key for ${handle}`);
  return k.id;
}

// A gathering written straight to the table, as if announced a day ago,
// starting startsInMinutes from now (negative: already started).
async function backdated(
  b: Bot,
  startsInMinutes: number,
  lasts: number,
  capacity: number | null = null,
): Promise<number> {
  const key = await keyOf(b.handle);
  const [g] = await db()<{ id: string }[]>`
    INSERT INTO gatherings (bot_id, key_id, title, starts_at, lasts_minutes, capacity, created_at)
    SELECT b.id, ${key}, 'Hackathon', now() + make_interval(mins => ${startsInMinutes}),
           ${lasts}, ${capacity}, now() - interval '1 day'
    FROM bots b WHERE b.handle = ${b.handle}
    RETURNING id`;
  return Number(g?.id);
}

async function stateOf(id: number): Promise<string> {
  const [r] = await db()<{ state: string }[]>`
    SELECT gathering_state(g) AS state FROM gatherings g WHERE g.id = ${id}`;
  return r?.state ?? "";
}

describe("a gathering's length", () => {
  it("says the same bounds in code, the schema and the database", async () => {
    expect([LASTS_MIN_MINUTES, LASTS_MAX_MINUTES]).toEqual([
      GATHERING_LASTS_MIN,
      GATHERING_LASTS_MAX,
    ]);
    expect(LASTS_MIN_MINUTES).toBe(OVER_MINUTES);
    const host = await trusted("host");
    for (const lasts of [LASTS_MIN_MINUTES - 1, LASTS_MAX_MINUTES + 1])
      await expect(backdated(host, 60, lasts)).rejects.toMatchObject({
        code: "23514",
      });
  });

  it("defaults to 30 minutes and shows no end then, so an old gathering reads as before", async () => {
    const host = await trusted("host");
    const res = await announce(host, { title: "Quick", starts_at: ahead(60) });
    expect(res.status).toBe(201);
    expect(res.body.gathering).not.toHaveProperty("ends_at");
    const [g] = await db()<{ lasts: number }[]>`
      SELECT lasts_minutes AS lasts FROM gatherings WHERE id = ${res.body.gathering.id}`;
    expect(g?.lasts).toBe(30);
  });

  it("takes lasts_minutes, shows ends_at, and refuses one out of bounds in words, writing nothing", async () => {
    const host = await trusted("host");
    const starts = ahead(60);
    const res = await announce(host, {
      title: "Bot hackathon",
      starts_at: starts,
      lasts_minutes: 180,
    });
    expect(res.status).toBe(201);
    expect(new Date(res.body.gathering.ends_at).getTime()).toBe(
      new Date(starts).getTime() + 180 * 60_000,
    );
    const count = async () =>
      Number(
        (
          await db()<{ n: number }[]>`SELECT count(*)::int AS n FROM gatherings`
        )[0]?.n,
      );
    const n = await count();
    for (const lasts of [29, 1441, 60.5, "90", 0, -30]) {
      const bad = await announce(host, {
        title: "Bad",
        starts_at: ahead(60),
        lasts_minutes: lasts,
      });
      expect(bad.status, String(lasts)).toBe(400);
      expect(bad.body.error.message).toContain(LASTS_REFUSAL);
    }
    expect(await count()).toBe(n);
  });

  it("is upcoming, starting, running until its end, then over", async () => {
    const host = await trusted("host");
    expect(await stateOf(await backdated(host, 60, 180))).toBe("upcoming");
    expect(await stateOf(await backdated(host, 10, 180))).toBe("starting");
    expect(await stateOf(await backdated(host, -20, 180))).toBe("starting");
    expect(await stateOf(await backdated(host, -40, 180))).toBe("running");
    expect(await stateOf(await backdated(host, -170, 180))).toBe("running");
    expect(await stateOf(await backdated(host, -181, 180))).toBe("over");
    // At the default length it never runs: starting, then over.
    expect(await stateOf(await backdated(host, -29, 30))).toBe("starting");
    expect(await stateOf(await backdated(host, -31, 30))).toBe("over");
  });

  it("stays listed and takes RSVPs while it runs, with no wake coming", async () => {
    const host = await trusted("host");
    const guest = await register("guest");
    const running = await backdated(host, -60, 180);
    const over = await backdated(host, -200, 180);
    const l = await list(guest);
    const ids = l.body.gatherings.map((g: { id: number }) => g.id);
    expect(ids).toContain(running);
    expect(ids).not.toContain(over);
    const shown = l.body.gatherings.find(
      (g: { id: number }) => g.id === running,
    );
    expect(shown.state).toBe("running");
    expect(shown.ends_at).toBeDefined();

    const res = await rsvp(guest, running, { going: true });
    expect(res.status).toBe(200);
    expect(res.body.rsvp.wake_at).toBeNull();
    expect(res.body.note).toBe(RSVP_NOTES.started);
    expect(res.body.gathering.coming).toBe(1);
    // An RSVP made after the start has no item: nothing fires for it.
    const items = await db()`
      SELECT 1 FROM due_items(now() - interval '1 day', 'infinity')
      WHERE event_id = ${running}`;
    expect(items).toHaveLength(0);

    const late = await rsvp(guest, over, { going: true });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("gathering_closed");
  });

  it("can't be cancelled once it runs, at the API or the database", async () => {
    const host = await trusted("host");
    const running = await backdated(host, -40, 180);
    const res = await cancel(host, running);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("gathering_started");
    await expect(db()`
      INSERT INTO gathering_ends (gathering_id, kind, key_id)
      VALUES (${running}, 'cancelled', ${await keyOf("host")})`).rejects.toThrow(
      /before it runs/,
    );
    // Still in its first half hour, a long one can be called off.
    const starting = await backdated(host, -20, 180);
    expect((await cancel(host, starting)).status).toBe(200);
  });

  it("lets a guest's block end its RSVP while it runs", async () => {
    const host = await trusted("host");
    const guest = await register("guest");
    const running = await backdated(host, -40, 180);
    expect((await rsvp(guest, running, { going: true })).status).toBe(200);
    const blocked = await call(blockRoute, {
      key: guest.key,
      params: { handle: host.handle },
    });
    expect(blocked.status).toBe(200);
    const [r] = await db()<{ key_id: string | null }[]>`
      SELECT key_id FROM gathering_rsvps WHERE gathering_id = ${running}
      ORDER BY id DESC LIMIT 1`;
    expect(r?.key_id).toBeNull();
  });

  it("opens a seat when a guest leaves while it runs, and none once it's over (084)", async () => {
    const host = await trusted("host");
    const guest = await register("guest");
    const running = await backdated(host, -40, 180);
    const wakes = async () => {
      const [w] = await db()<{ count: string }[]>`
        SELECT w.count FROM wake_counters w JOIN bots b ON b.id = w.bot_id
        WHERE b.handle = ${host.handle}`;
      return Number(w?.count ?? 0);
    };
    expect((await rsvp(guest, running, { going: true })).status).toBe(200);
    const before = await wakes();
    const left = await rsvp(guest, running, {
      going: false,
      reason: "unavailable",
    });
    expect(left.status).toBe(200);
    expect(await wakes()).toBe(before + 1);
    const [row] = await db()<{ seat_opened: boolean }[]>`
      SELECT seat_opened FROM gathering_rsvps WHERE gathering_id = ${running}
      ORDER BY id DESC LIMIT 1`;
    expect(row?.seat_opened).toBe(true);
    // Over: past its end, nothing opens, even at the table.
    const over = await backdated(host, -200, 180);
    const key = await keyOf(guest.handle);
    // An RSVP from while it ran, written past the check that now refuses it.
    await db().begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`
        INSERT INTO gathering_rsvps (gathering_id, bot_id, key_id, notice_minutes)
        SELECT ${over}, b.id, ${key}, 10 FROM bots b WHERE b.handle = ${guest.handle}`;
    });
    const atOver = await wakes();
    await db()`
      INSERT INTO gathering_rsvps (gathering_id, bot_id, key_id)
      SELECT ${over}, b.id, NULL FROM bots b WHERE b.handle = ${guest.handle}`;
    const [late] = await db()<{ seat_opened: boolean }[]>`
      SELECT seat_opened FROM gathering_rsvps WHERE gathering_id = ${over}
      ORDER BY id DESC LIMIT 1`;
    expect(late?.seat_opened).toBe(false);
    expect(await wakes()).toBe(atOver);
  });

  it("hands a freed seat to the first waiting while it runs (085)", async () => {
    const host = await trusted("host");
    const a = await register("guest-a");
    const b = await register("guest-b");
    const running = await backdated(host, -40, 180, 1);
    expect((await rsvp(a, running, { going: true })).status).toBe(200);
    const waits = await rsvp(b, running, { going: true });
    expect(waits.status).toBe(200);
    expect(waits.body.rsvp.waitlist_place).toBe(1);
    // Under way: no reminder follows a seat, and nothing wakes b, so it's
    // told to look again while it runs, not before its start.
    expect(waits.body.note).toBe(waitingNote(true, true));
    expect(waits.body.note).not.toContain("reminders follow");
    expect(waits.body.note).not.toContain("before its start");
    const [bId] = await db()<{ id: string }[]>`
      SELECT id FROM bots WHERE handle = ${b.handle}`;
    const wakeOf = async () => {
      const [w] = await db()<{ n: string }[]>`
        SELECT coalesce((SELECT count FROM wake_counters WHERE bot_id = ${bId?.id ?? 0}), 0) AS n`;
      return Number(w?.n);
    };
    const before = await wakeOf();
    const left = await rsvp(a, running, {
      going: false,
      reason: "unavailable",
    });
    expect(left.status).toBe(200);
    const [row] = await db()<
      { promoted_bot_id: string | null; seat_opened: boolean }[]
    >`
      SELECT promoted_bot_id, seat_opened FROM gathering_rsvps
      WHERE gathering_id = ${running} ORDER BY id DESC LIMIT 1`;
    expect(Number(row?.promoted_bot_id)).toBe(Number(bId?.id));
    expect(row?.seat_opened).toBe(false);
    // Handed the seat, b hears of it at once.
    expect(await wakeOf()).toBeGreaterThan(before);
  });

  it("shows in its announcer's what's new while it runs", async () => {
    const host = await trusted("host");
    const running = await backdated(host, -120, 180);
    const d = await digest(host);
    const g = d.body.gatherings.find((x: { id: number }) => x.id === running);
    expect(g?.state).toBe("running");
  });

  it("keeps a running one ahead of finished ones in its announcer's what's new", async () => {
    const host = await trusted("host");
    // Nine finished ones that started earlier, which used to sort ahead of
    // a running one and push it past the cut.
    for (let i = 0; i < 9; i++) await backdated(host, -600 + i * 20, 30);
    const running = await backdated(host, -120, 180);
    const d = await digest(host);
    const g = d.body.gatherings.find((x: { id: number }) => x.id === running);
    expect(g?.state).toBe("running");
  });

  it("shows another bot's running one among the others in what's new, until its end", async () => {
    const host = await trusted("host");
    const reader = await register("reader");
    const running = await backdated(host, -120, 180);
    const over = await backdated(host, -200, 180);
    const ids = (await digest(reader)).body.gatherings.map(
      (x: { id: number }) => x.id,
    );
    expect(ids).toContain(running);
    expect(ids).not.toContain(over);
  });

  it("lists one that ended early only until 30 minutes past its start", async () => {
    const host = await trusted("host");
    const reader = await register("reader");
    const cancelled = await backdated(host, -20, 180);
    expect((await cancel(host, cancelled)).status).toBe(200);
    const short = await backdated(host, -40, 180);
    await db()`
      INSERT INTO gathering_ends (gathering_id, kind)
      VALUES (${short}, 'short')`;
    const ids = (await list(reader)).body.gatherings.map(
      (g: { id: number }) => g.id,
    );
    expect(ids).toContain(cancelled);
    expect(ids).not.toContain(short);
  });

  it("is set through set_event's announce, and refused on any other action", async () => {
    const host = await trusted("host");
    let id = 0;
    async function tool(args: object) {
      id += 1;
      const req = new Request("http://unprompted.test/v1/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "x-real-ip": freshIp(),
          host: "unprompted.test",
          authorization: `Bearer ${host.key}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: "set_event", arguments: args },
        }),
      });
      const result = (await (await mcpRoute(req, undefined as never)).json())
        .result;
      const text = (result?.content?.[0]?.text ?? "") as string;
      let data: unknown = text;
      try {
        data = JSON.parse(text);
      } catch {}
      return { isError: result?.isError === true, data, text };
    }
    const ok = await tool({
      action: "announce",
      title: "Weekend jam",
      starts_at: ahead(90),
      lasts_minutes: 600,
    });
    expect(ok.isError).toBe(false);
    const g = (ok.data as { gathering: { id: number; ends_at: string } })
      .gathering;
    const [row] = await db()<{ lasts: number }[]>`
      SELECT lasts_minutes AS lasts FROM gatherings WHERE id = ${g.id}`;
    expect(row?.lasts).toBe(600);
    const wrong = await tool({
      action: "move",
      gathering: g.id,
      starts_at: ahead(120),
      lasts_minutes: 60,
    });
    expect(wrong.isError).toBe(true);
  });
});

describe("a waitlisted bot's note", () => {
  it("promises reminders only before the start, and asks only an unwoken bot to look again", () => {
    expect(waitingNote(false, false)).toContain(
      "if that's before its start, its reminders follow",
    );
    expect(waitingNote(false, false)).not.toContain("list_gatherings");
    expect(waitingNote(false, true)).toContain(
      "before its start (list_gatherings",
    );
    expect(waitingNote(true, false)).toContain("no reminder follows");
    expect(waitingNote(true, false)).not.toContain("list_gatherings");
    expect(waitingNote(true, true)).toContain("while it runs");
    for (const unwoken of [false, true])
      expect(waitingNote(true, unwoken)).not.toContain("reminders follow");
  });
});
