import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as eventsRoute } from "@/app/v1/events/route";
import { POST as rsvpRoute } from "@/app/v1/gatherings/[id]/rsvp/route";
import { GET as gatheringsRoute } from "@/app/v1/gatherings/route";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { GET as catchUpRoute } from "@/app/v1/me/catch-up/route";
import { GET as digestRoute } from "@/app/v1/me/digest/route";
import { GET as meRoute } from "@/app/v1/me/route";
import { GET as startRoute } from "@/app/v1/me/start/route";
import { GET as wakeRoute } from "@/app/v1/me/wake/route";
import { POST as wakeUrlRoute } from "@/app/v1/me/wake/url/route";
import { POST as postRoute } from "@/app/v1/posts/route";
import { GET as channelRoute } from "@/app/v1/private-channels/[id]/route";
import { db } from "@/lib/db";
import { workDue } from "@/lib/due";
import { NEXT_VISIT_FALLBACK_HOURS } from "@/lib/next-visit";
import { startChannel } from "@/lib/private-channels";
import { call, freshIp, register, resetDb } from "./helpers";

// B3f: next_visit is one rule (nextVisit() in src/lib/next-visit.ts), and
// every answer that carries it must name the same thing at the same state:
// the reads (the digest, catch_up, check_wake and /v1/me/wake, getting
// started's come_back) and the writes, worked out after they commit (an
// RSVP, a post's back block, set_event). A write's own time (wake_at,
// back.at) may differ from it; the item it names may not. Reads that
// aren't about coming back (whoami, read_channel, list_gatherings) carry
// none. Only the fallback's and a clamp's at may move with the read's own
// clock.

beforeEach(resetDb);

type Bot = { handle: string; key: string };
type Visit = {
  at: string | null;
  why: string;
  item?: Record<string, unknown>;
  woken_by: string;
  note: string;
};

const MIN = 60_000;
const HOUR = 60 * MIN;

async function aged(handle: string): Promise<Bot> {
  const b = await register(handle);
  await db()`UPDATE bots SET created_at = now() - interval '3 days' WHERE handle = ${handle}`;
  return b;
}

async function fresh(): Promise<void> {
  await db()`DELETE FROM rate_limits`;
  await db()`DELETE FROM rate_bursts`;
}

async function dbNow(): Promise<number> {
  const [r] = await db()<{ now: Date }[]>`SELECT now() AS now`;
  return r?.now.getTime() ?? 0;
}

let rpcId = 0;
async function tool(b: Bot, name: string, args: Record<string, unknown> = {}) {
  rpcId += 1;
  await fresh();
  const req = new Request("http://unprompted.test/v1/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-real-ip": freshIp(),
      host: "unprompted.test",
      authorization: `Bearer ${b.key}`,
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
  expect(result?.isError, `${name}: ${JSON.stringify(result)}`).not.toBe(true);
  return JSON.parse(result?.content?.[0]?.text ?? "null") as unknown;
}

// Every next_visit anywhere in an answer.
function visitsIn(value: unknown, out: Visit[] = []): Visit[] {
  if (Array.isArray(value)) for (const v of value) visitsIn(v, out);
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      if (k === "next_visit") out.push(v as Visit);
      else visitsIn(v, out);
    }
  return out;
}

function keysIn(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysIn(v, out);
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysIn(v, out);
    }
  return out;
}

// Every read that carries the caller's next_visit, over HTTP and the
// connector, full and compact: what it said, and where.
async function reads(b: Bot): Promise<{ where: string; visit: Visit }[]> {
  const got: { where: string; visit: Visit }[] = [];
  const keep = (where: string, answer: unknown, atLeast = 1) => {
    const vs = visitsIn(answer);
    expect(
      vs.length,
      `${where}: ${JSON.stringify(answer)}`,
    ).toBeGreaterThanOrEqual(atLeast);
    for (const visit of vs) got.push({ where, visit });
  };
  for (const view of ["", "?view=compact"]) {
    const d = await call(digestRoute, {
      key: b.key,
      path: `/v1/me/digest${view}`,
    });
    expect(d.status).toBe(200);
    keep(`digest${view}`, d.body);
    const c = await call(catchUpRoute, {
      key: b.key,
      path: `/v1/me/catch-up${view}`,
    });
    expect(c.status).toBe(200);
    keep(`catch-up${view}`, c.body);
  }
  const w = await call(wakeRoute, { key: b.key, path: "/v1/me/wake" });
  expect(w.status).toBe(200);
  keep("/v1/me/wake", w.body);
  // Getting started carries it in come_back only while the site isn't known
  // to reach the bot; none of these bots is.
  for (const view of ["", "?view=compact"]) {
    const s = await call(startRoute, {
      key: b.key,
      path: `/v1/me/start${view}`,
    });
    expect(s.status).toBe(200);
    keep(`/v1/me/start${view}`, s.body);
  }
  keep("check_wake", await tool(b, "check_wake"));
  // The connector answers compact unless asked for the full view.
  for (const name of ["read_digest", "catch_up", "getting_started"])
    for (const view of ["compact", "full"])
      keep(`${name} ${view}`, await tool(b, name, { view }));
  return got;
}

// The part every surface must agree on exactly; at is compared to the
// second, since a compact view drops milliseconds.
function core(v: Visit) {
  return {
    at: v.at === null ? null : Math.floor(Date.parse(v.at) / 1000),
    why: v.why,
    woken_by: v.woken_by,
    item: v.item ?? null,
  };
}

function allAgree(
  got: { where: string; visit: Visit }[],
  want: ReturnType<typeof core>,
): void {
  for (const { where, visit } of got) expect(core(visit), where).toEqual(want);
}

async function backPost(b: Bot, minutes: number, title = "Back soon") {
  await fresh();
  const res = await call(postRoute, {
    key: b.key,
    body: {
      channel: "meta",
      title,
      body: "Looking again later.",
      back_in_minutes: minutes,
    },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return {
    id: res.body.post.id as number,
    back: res.body.back as { at?: string; next_visit?: Visit },
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

async function rsvp(b: Bot, g: number, going: boolean, notice = 10) {
  await fresh();
  const res = await call(rsvpRoute, {
    key: b.key,
    body: going ? { going, notice_minutes: notice } : { going },
    params: { id: String(g) },
    path: `/v1/gatherings/${g}/rsvp`,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.rsvp as { wake_at: string | null; next_visit?: Visit };
}

// Nothing coming but something open: why open, no item, and a day from
// each answer's own read, between before and after on the site's clock (a
// compact view drops milliseconds).
function isOpen(
  got: { where: string; visit: Visit | undefined }[],
  reach: string,
  before: number,
  after: number,
): void {
  const day = NEXT_VISIT_FALLBACK_HOURS * HOUR;
  for (const { where, visit } of got) {
    expect(visit, where).toBeDefined();
    expect(visit?.why, where).toBe("open");
    expect(visit?.woken_by, where).toBe(reach);
    expect(visit, where).not.toHaveProperty("item");
    const at = Date.parse(String(visit?.at));
    expect(at, where).toBeGreaterThanOrEqual(before + day - 1000);
    expect(at, where).toBeLessThanOrEqual(after + day);
  }
}

async function wakeUrl(b: Bot): Promise<void> {
  const res = await call(wakeUrlRoute, { key: b.key, method: "POST" });
  expect(res.status).toBe(201);
}

describe("a coming item", () => {
  for (const reach of ["wake_url", "none"] as const)
    it(`is named alike by every read and write (${reach})`, async () => {
      const a = await aged("alice");
      const host = await aged("host");
      if (reach === "wake_url") await wakeUrl(a);
      // The first time to come: a back item in 20 minutes.
      const first = await backPost(a, 20);
      const want = {
        at: Math.floor(Date.parse(String(first.back.at)) / 1000),
        why: "back",
        woken_by: reach,
        item: { kind: "back", event: first.id, occurrence: 0 },
      };
      expect(first.back.next_visit, "the back block").toBeDefined();
      expect(core(first.back.next_visit as Visit)).toEqual(want);
      // A later RSVP has its own wake_at, but the earlier item still wins.
      const g = await gathering(host, 90);
      const r = await rsvp(a, g, true, 10);
      expect(Date.parse(String(r.wake_at))).toBeGreaterThan(
        Date.parse(String(first.back.at)),
      );
      expect(core(r.next_visit as Visit), "the RSVP").toEqual(want);
      // So does a later back time in another thread.
      const later = await backPost(a, 300, "Much later");
      expect(Date.parse(String(later.back.at))).toBeGreaterThan(
        Date.parse(String(first.back.at)),
      );
      expect(core(later.back.next_visit as Visit), "a later back").toEqual(
        want,
      );
      // The connector's writes answer the same: a post with a later time,
      // and the RSVP said again with another notice.
      const viaPost = (await tool(a, "post", {
        channel: "meta",
        title: "Later still",
        body: "Looking again much later.",
        back_in_minutes: 400,
      })) as { back: { next_visit: Visit } };
      expect(core(viaPost.back.next_visit), "the connector's post").toEqual(
        want,
      );
      const viaRsvp = (await tool(a, "rsvp", {
        gathering: g,
        going: true,
        notice_minutes: 5,
      })) as { rsvp: { next_visit: Visit } };
      expect(core(viaRsvp.rsvp.next_visit), "the connector's RSVP").toEqual(
        want,
      );
      allAgree(await reads(a), want);
    });

  it("keeps a bot nothing wakes an hour past its last time, alike everywhere", async () => {
    const a = await aged("alice");
    // A back item that has fired, then one inside the hour after it: the
    // second is named at the hour's end, never at its own time.
    const fired = await backPost(a, 10);
    const firedAt = Date.parse(String(fired.back.at));
    await workDue(new Date(firedAt + MIN));
    const soon = await backPost(a, 30, "Soon after");
    const own = Date.parse(String(soon.back.at));
    expect(own).toBeLessThan(firedAt + HOUR);
    const want = {
      at: Math.floor((firedAt + HOUR) / 1000),
      why: "back",
      woken_by: "none",
      item: { kind: "back", event: soon.id, occurrence: 0 },
    };
    expect(core(soon.back.next_visit as Visit), "the back block").toEqual(want);
    allAgree(await reads(a), want);
  });

  it("names the RSVP, written last, when it's the soonest", async () => {
    const a = await aged("alice");
    const host = await aged("host");
    await wakeUrl(a);
    await backPost(a, 120);
    const g = await gathering(host, 40);
    const r = await rsvp(a, g, true, 15);
    const want = {
      at: Math.floor(Date.parse(String(r.wake_at)) / 1000),
      why: "rsvp",
      woken_by: "wake_url",
      item: { kind: "rsvp", event: g, occurrence: 0 },
    };
    expect(core(r.next_visit as Visit), "the RSVP").toEqual(want);
    allAgree(await reads(a), want);
  });

  // EV5: a gathering's start is an item of its own, so a guest with a notice
  // of 0 is named the start, and one whose notice has fired is named the
  // start next, the same item everywhere.
  it("names a gathering's start for a guest with a notice of 0", async () => {
    const a = await aged("alice");
    const host = await aged("host");
    await wakeUrl(a);
    const g = await gathering(host, 40);
    const r = await rsvp(a, g, true, 0);
    const want = {
      at: Math.floor(Date.parse(String(r.wake_at)) / 1000),
      why: "start",
      woken_by: "wake_url",
      item: { kind: "start", event: g, occurrence: 0 },
    };
    expect(core(r.next_visit as Visit), "the RSVP").toEqual(want);
    allAgree(await reads(a), want);
  });

  it("names the start once the notice has fired", async () => {
    const a = await aged("alice");
    const host = await aged("host");
    await wakeUrl(a);
    const g = await gathering(host, 40);
    const r = await rsvp(a, g, true, 15);
    const notice = Date.parse(String(r.wake_at));
    expect((await workDue(new Date(notice + 1000))).fired).toBe(1);
    const start = notice + 15 * MIN;
    const want = {
      at: Math.floor(start / 1000),
      why: "start",
      woken_by: "wake_url",
      item: { kind: "start", event: g, occurrence: 0 },
    };
    // Said again, the RSVP's own answer names the start too.
    const again = await rsvp(a, g, true, 15);
    expect(Date.parse(String(again.wake_at))).toBe(start);
    expect(core(again.next_visit as Visit), "the RSVP again").toEqual(want);
    allAgree(await reads(a), want);
  });
});

describe("nothing coming", () => {
  it("with something open, every answer says open, no item, a day from its own read", async () => {
    const a = await aged("alice");
    const host = await aged("host");
    await wakeUrl(a);
    // A thread alice started today keeps something open.
    await fresh();
    const t = await call(postRoute, {
      key: a.key,
      body: { channel: "meta", title: "Open", body: "A thread." },
    });
    expect(t.status).toBe(201);
    // An RSVP set and taken back leaves nothing due; its answer says so.
    const g = await gathering(host, 60);
    await rsvp(a, g, true);
    const before = await dbNow();
    const off = await rsvp(a, g, false);
    const got = [
      { where: "the RSVP taken back", visit: off.next_visit as Visit },
      ...(await reads(a)),
    ];
    isOpen(got, "wake_url", before, await dbNow());
  });

  it("with nothing open, every answer says nothing, at null, no item", async () => {
    const a = await aged("alice");
    const host = await aged("host");
    const g = await gathering(host, 60);
    await rsvp(a, g, true);
    const off = await rsvp(a, g, false);
    const want = { at: null, why: "nothing", woken_by: "none", item: null };
    expect(core(off.next_visit as Visit), "the RSVP taken back").toEqual(want);
    allAgree(await reads(a), want);
  });
});

describe("an item past due that the next run will still fire", () => {
  it("is named at now by every read and write, never earlier", async () => {
    const a = await aged("alice");
    const host = await aged("host");
    await wakeUrl(a);
    await fresh();
    const thread = await call(postRoute, {
      key: host.key,
      body: { channel: "meta", title: "Thread", body: "A thread." },
    });
    expect(thread.status).toBe(201);
    // Alice's reply, whose time has already come, written as only a test
    // can: the clock hasn't run, so it's still coming, inside its late
    // window. Nothing due before the due-list began (event_fires_epoch(),
    // when its migration ran) is on it, and an item past its 90-minute window
    // is missed, so its time is halfway between the later of the two and now.
    const [row] = await db()<{ id: string; back_at: Date }[]>`
      INSERT INTO posts (channel_id, bot_id, key_id, parent_id, body, created_at, back_at)
      SELECT p.channel_id, b.id, k.id, p.id, 'Back soon.',
             now() - interval '30 minutes',
             greatest(event_fires_epoch(), now() - interval '20 minutes')
               + (now() - greatest(event_fires_epoch(), now() - interval '20 minutes')) / 2
      FROM posts p, bots b JOIN api_keys k ON k.bot_id = b.id AND k.revoked_at IS NULL
      WHERE p.id = ${thread.body.post.id} AND b.handle = ${a.handle}
      RETURNING id, back_at`;
    const t = { id: Number(row?.id) };
    const due = row?.back_at.getTime() ?? 0;
    const g = await gathering(host, 120);
    const before = await dbNow();
    expect(due).toBeLessThan(before);
    const r = await rsvp(a, g, true);
    const got = [
      { where: "the RSVP", visit: r.next_visit as Visit },
      ...(await reads(a)),
    ];
    const after = await dbNow();
    for (const { where, visit } of got) {
      expect(visit.why, where).toBe("back");
      expect(visit.woken_by, where).toBe("wake_url");
      expect(visit.item, where).toEqual({
        kind: "back",
        event: t.id,
        occurrence: 0,
      });
      const at = Date.parse(String(visit.at));
      expect(at, where).toBeGreaterThan(due);
      expect(at, where).toBeGreaterThanOrEqual(before - 1000);
      expect(at, where).toBeLessThanOrEqual(after);
    }
  });
});

describe("a declined session", () => {
  async function group(): Promise<{ a: Bot; b: Bot; g: string }> {
    const bots: Bot[] = [];
    for (const h of ["alice", "bob"]) bots.push(await aged(h));
    const [h] = await db()<{ id: string }[]>`
      INSERT INTO humans (auth_user_id) VALUES ('google-b3f') RETURNING id`;
    for (const x of bots)
      await db()`UPDATE bots SET owner_id = ${h?.id ?? null} WHERE handle = ${x.handle}`;
    const [a, b] = bots as [Bot, Bot];
    const r = await startChannel(
      db(),
      "google-b3f",
      bots.map((x) => x.handle),
      b.handle,
      null,
    );
    return { a, b, g: r.channel };
  }

  const event = async (b: Bot, body: object) => {
    await fresh();
    const res = await call(eventsRoute, {
      key: b.key,
      body,
      path: "/v1/events",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as { next_visit?: Visit; session?: { at: string } };
  };

  it("never wins, though it comes first; the setter's own session does", async () => {
    const { a, b, g } = await group();
    await wakeUrl(a);
    await wakeUrl(b);
    const set = await event(b, {
      action: "session",
      channel: g,
      in_minutes: 15,
    });
    const before = await dbNow();
    const no = await event(a, { action: "answer", channel: g, coming: false });
    // Alice's group is open, and nothing she'll be woken for is coming: her
    // answer and every read say so alike.
    isOpen(
      [{ where: "her answer", visit: no.next_visit }, ...(await reads(a))],
      "wake_url",
      before,
      await dbNow(),
    );
    const later = await backPost(a, 120);
    const want = {
      at: Math.floor(Date.parse(String(later.back.at)) / 1000),
      why: "back",
      woken_by: "wake_url",
      item: { kind: "back", event: later.id, occurrence: 0 },
    };
    expect(core(later.back.next_visit as Visit)).toEqual(want);
    // Her due holds the declined session, sooner than the back item.
    const d = await call(digestRoute, { key: a.key, path: "/v1/me/digest" });
    const declined = (d.body.due as { state: string; at: string }[]).filter(
      (x) => x.state === "declined",
    );
    expect(declined.length).toBeGreaterThan(0);
    expect(Date.parse(String(declined[0]?.at))).toBeLessThan(
      Date.parse(String(later.back.at)),
    );
    allAgree(await reads(a), want);
    // Bob, who set it and didn't decline, is named the session by his write
    // and by every read alike.
    const bobs = core(set.next_visit as Visit);
    expect(bobs).toMatchObject({ why: "session", woken_by: "wake_url" });
    expect(bobs.item).toMatchObject({ kind: "session", channel: g });
    allAgree(await reads(b), bobs);
    // The connector's set_event answers as the route does.
    const again = (await tool(a, "set_event", {
      action: "answer",
      channel: g,
      coming: false,
    })) as { next_visit: Visit };
    expect(core(again.next_visit), "her answer over the connector").toEqual(
      want,
    );
    // Ending it leaves Bob's group open and nothing coming, alike.
    const t0 = await dbNow();
    const end = await event(b, { action: "end", channel: g });
    isOpen(
      [{ where: "the end", visit: end.next_visit }, ...(await reads(b))],
      "wake_url",
      t0,
      await dbNow(),
    );
  });

  it("answers a committed set_event without next_visit, never an error, when the read after it fails", async () => {
    const { b, g } = await group();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let res: Awaited<ReturnType<typeof call>>;
    let calls: unknown[][] = [];
    await db()`ALTER FUNCTION due_items(timestamptz, timestamptz, bigint) RENAME TO due_items_gone`;
    try {
      await fresh();
      res = await call(eventsRoute, {
        key: b.key,
        body: { action: "session", channel: g, in_minutes: 15 },
        path: "/v1/events",
      });
    } finally {
      await db()`ALTER FUNCTION due_items_gone(timestamptz, timestamptz, bigint) RENAME TO due_items`;
      calls = [...errors.mock.calls];
      errors.mockRestore();
    }
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.session).toBeTruthy();
    expect(res.body).not.toHaveProperty("next_visit");
    expect(calls).toContainEqual([
      expect.stringMatching(/next_visit after a write committed/),
      expect.anything(),
    ]);
    // Written once; the next read names it.
    const [n] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM channel_sessions`;
    expect(n?.n).toBe(1);
    const w = await call(wakeRoute, { key: b.key, path: "/v1/me/wake" });
    expect(w.body.next_visit.why).toBe("session");
  });
});

describe("reads that aren't about coming back", () => {
  it("carry no next_visit, even with an item coming", async () => {
    const a = await aged("alice");
    const b = await aged("bob");
    await backPost(a, 30);
    const [h] = await db()<{ id: string }[]>`
      INSERT INTO humans (auth_user_id) VALUES ('google-b3f-2') RETURNING id`;
    for (const x of [a, b])
      await db()`UPDATE bots SET owner_id = ${h?.id ?? null} WHERE handle = ${x.handle}`;
    const r = await startChannel(
      db(),
      "google-b3f-2",
      [a.handle, b.handle],
      a.handle,
      null,
    );
    // A gathering she's coming to, so the lists hold one with her RSVP.
    const g = await gathering(b, 90);
    await rsvp(a, g, true);
    const id = r.channel.replace(/^private:/, "");
    const ok = (res: { status: number; body: unknown }, where: string) => {
      expect(res.status, where).toBe(200);
      return res.body;
    };
    const lists = ok(
      await call(gatheringsRoute, { key: a.key, path: "/v1/gatherings" }),
      "/v1/gatherings",
    );
    expect(JSON.stringify(lists)).toContain(`"id":${g}`);
    const answers: [string, unknown][] = [
      ["/v1/me", ok(await call(meRoute, { key: a.key, path: "/v1/me" }), "me")],
      ["/v1/gatherings", lists],
      [
        "/v1/private-channels/{id}",
        ok(
          await call(channelRoute, {
            key: a.key,
            path: `/v1/private-channels/${id}`,
            params: { id },
          }),
          "channel",
        ),
      ],
      ["whoami", await tool(a, "whoami")],
      ["list_gatherings", await tool(a, "list_gatherings")],
      ["read_channel", await tool(a, "read_channel", { channel: r.channel })],
    ];
    for (const [where, answer] of answers) {
      expect(answer, where).toBeTruthy();
      expect(keysIn(answer).has("next_visit"), where).toBe(false);
    }
  });
});
