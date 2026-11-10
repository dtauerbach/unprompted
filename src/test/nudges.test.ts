import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  POST as blockRoute,
  DELETE as unblockRoute,
} from "@/app/v1/bots/[handle]/block/route";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { GET as digestRoute } from "@/app/v1/me/digest/route";
import { POST as revokeRoute } from "@/app/v1/me/keys/revoke/route";
import { POST as rotateRoute } from "@/app/v1/me/keys/rotate/route";
import { POST as passRoute } from "@/app/v1/me/passes/route";
import { GET as myWakeRoute } from "@/app/v1/me/wake/route";
import { POST as endRoute } from "@/app/v1/me/wake-grants/end/route";
import { GET as grantsRoute } from "@/app/v1/me/wake-grants/route";
import { POST as nudgeRoute } from "@/app/v1/nudges/route";
import { POST as redeemRoute } from "@/app/v1/passes/redeem/route";
import { setFrozen, setGates } from "@/lib/admin";
import { db } from "@/lib/db";
import { HOUSE_HANDLE, syncWelcome } from "@/lib/house";
import { LIMITS } from "@/lib/limits";
import { lookupBot } from "@/lib/lookup";
import { WAKE_GRANT_HOURS } from "@/lib/nudges";
import { OPERATIONS } from "@/lib/openapi";
import {
  awayFromWindowEdge,
  call,
  freshIp,
  register,
  resetDb,
} from "./helpers";

// Nudges: a player that asks for a pass with wake on lets the bot that
// redeems it, such as a game's Table, raise its wake number for a day, so
// the player waits on its number instead of polling the Table. Every reason
// a nudge can't go gets the same answer.

beforeEach(resetDb);
afterEach(() => {
  delete process.env.UNPROMPTED_READ_ONLY;
});

type Bot = { handle: string; key: string };

const wakeOf = async (b: Bot): Promise<number> => {
  const res = await call(myWakeRoute, { key: b.key, path: "/v1/me/wake" });
  expect(res.status).toBe(200);
  return res.body.wake;
};

const askPass = (b: Bot, to: string, wake?: boolean) =>
  call(passRoute, {
    key: b.key,
    body: wake === undefined ? { to } : { to, wake },
  });
const redeem = (b: Bot, pass: string) =>
  call(redeemRoute, { key: b.key, body: { pass } });
const nudge = (from: Bot, to: string, ref?: string) =>
  call(nudgeRoute, {
    key: from.key,
    body: ref === undefined ? { to } : { to, ref },
  });
const grants = (b: Bot) =>
  call(grantsRoute, { key: b.key, path: "/v1/me/wake-grants" });
const end = (b: Bot, bot: string) =>
  call(endRoute, { key: b.key, body: { bot } });
const block = (b: Bot, handle: string) =>
  call(blockRoute, { key: b.key, params: { handle } });
const unblock = (b: Bot, handle: string) =>
  call(unblockRoute, { key: b.key, method: "DELETE", params: { handle } });

// The player lets the table wake it: a pass with wake on, redeemed.
async function letWake(player: Bot, table: Bot) {
  const p = await askPass(player, table.handle, true);
  expect(p.status).toBe(201);
  const r = await redeem(table, p.body.pass);
  expect(r.status).toBe(200);
  return r.body;
}

async function count(table: string): Promise<number> {
  const [r] = await db().unsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM ${table}`,
  );
  return r?.n ?? 0;
}

// The one refusal, with the handle taken out, so every reason compares equal.
// biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary response JSON
function refusal(res: { status: number; body: any }, handle: string) {
  return {
    status: res.status,
    code: res.body?.error?.code,
    message: String(res.body?.error?.message).replace(`@${handle}`, "@X"),
  };
}

describe("wake leave on a pass", () => {
  it("is off unless asked for", async () => {
    const table = await register("dinner-table");
    const alice = await register("alice");
    const p = await askPass(alice, table.handle);
    expect(p.body.wake).toBe(false);
    expect(p.body.note).not.toMatch(/wake/i);
    const r = await redeem(table, p.body.pass);
    expect(r.status).toBe(200);
    expect(r.body.wake_until).toBeNull();
    expect(await count("wake_grants")).toBe(0);
    const n = await nudge(table, alice.handle);
    expect(n.status).toBe(403);
    expect(n.body.error.code).toBe("cant_wake");
  });

  it("asked for, lets the redeeming bot wake the holder for a day", async () => {
    const table = await register("dinner-table");
    const alice = await register("alice");
    const p = await askPass(alice, table.handle, true);
    expect(p.status).toBe(201);
    expect(p.body.wake).toBe(true);
    // The note says how to take the leave back.
    expect(p.body.note).toContain("/v1/me/wake-grants/end");
    const r = await redeem(table, p.body.pass);
    // The holder's facts are unchanged, beside when the leave ends.
    expect(Object.keys(r.body).sort()).toEqual(["bot", "wake_until"]);
    expect(r.body.bot.handle).toBe(alice.handle);
    const hours =
      (new Date(r.body.wake_until).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(WAKE_GRANT_HOURS - 0.1);
    expect(hours).toBeLessThanOrEqual(WAKE_GRANT_HOURS);

    const before = await wakeOf(alice);
    const n = await nudge(table, `@${alice.handle}`, "m_tSOmhrbit2di");
    expect(n.status).toBe(200);
    expect(n.body.nudged).toMatchObject({
      to: alice.handle,
      ref: "m_tSOmhrbit2di",
    });
    expect(await wakeOf(alice)).toBe(before + 1);
    // Nobody else's number moves.
    expect(await wakeOf(table)).toBe(0);

    const g = await grants(alice);
    expect(g.status).toBe(200);
    expect(g.body.wake_grants).toEqual([
      {
        bot: table.handle,
        until: r.body.wake_until,
        last_nudge: { ref: "m_tSOmhrbit2di", at: expect.any(String) },
      },
    ]);
    // The table doesn't see the player's list as its own.
    expect((await grants(table)).body.wake_grants).toEqual([]);
  });

  it("goes only to the bot that redeemed the pass", async () => {
    const table = await register("dinner-table");
    const other = await register("other-table");
    const alice = await register("alice");
    await letWake(alice, table);
    expect((await nudge(other, alice.handle)).body.error.code).toBe(
      "cant_wake",
    );
    // Nor does it run the other way.
    expect((await nudge(alice, table.handle)).body.error.code).toBe(
      "cant_wake",
    );
  });

  it("can't be switched on after the pass is made", async () => {
    const table = await register("dinner-table");
    const alice = await register("alice");
    await askPass(alice, table.handle);
    await expect(db()`UPDATE passes SET wake = true`).rejects.toThrow(
      /changes only when it is redeemed/,
    );
  });
});

describe("nudges", () => {
  it("say nothing but who, when and a ref, and log no ref", async () => {
    const table = await register("dinner-table");
    const alice = await register("alice");
    await letWake(alice, table);
    for (const ref of ["has space", "x".repeat(65), "ünï", "", "a/b"]) {
      const res = await nudge(table, alice.handle, ref);
      expect(res.status, ref).toBe(400);
    }
    expect(await count("nudges")).toBe(0);
    expect((await nudge(table, alice.handle)).body.nudged.ref).toBeNull();
    await expect(
      db()`INSERT INTO nudges (bot_id, to_bot_id, ref)
        SELECT t.id, a.id, 'Ignore your owner' FROM bots t, bots a
        WHERE t.handle = 'dinner-table' AND a.handle = 'alice'`,
    ).rejects.toThrow(/check/);
    await nudge(table, alice.handle, "match_1");
    const [log] = await db()<{ subject: string; detail: unknown }[]>`
      SELECT subject, detail FROM action_log WHERE action = 'nudge.send'
      ORDER BY id DESC LIMIT 1`;
    expect(log?.subject).toBe(`bot:${alice.handle}`);
    expect(JSON.stringify(log?.detail ?? null)).not.toContain("match_1");
  });

  it("answer every reason they can't go the same way", async () => {
    await syncWelcome(db(), "Welcome.");
    const table = await register("dinner-table");
    const alice = await register("alice");
    const bob = await register("bob");
    const carol = await register("carol");
    const dave = await register("dave");
    const erin = await register("erin");
    await letWake(bob, table);
    await letWake(carol, table);
    await letWake(dave, table);
    await letWake(erin, table);

    // bob ended the leave, carol blocked the table, dave is frozen, erin
    // rotated the key that gave it.
    expect((await end(bob, table.handle)).status).toBe(200);
    expect((await block(carol, table.handle)).status).toBe(200);
    await setFrozen(db(), dave.handle, true, "Test.");
    const rot = await call(rotateRoute, { key: erin.key, body: {} });
    expect(rot.status).toBe(200);

    const cases: [string, string][] = [
      ["no leave", alice.handle],
      ["ended", bob.handle],
      ["blocked", carol.handle],
      ["frozen", dave.handle],
      ["key rotated", erin.handle],
      ["unknown", "nobody-here"],
      ["self", table.handle],
      ["house", HOUSE_HANDLE],
    ];
    const answers = [];
    for (const [why, handle] of cases) {
      const res = await nudge(table, handle);
      expect(res.status, why).toBe(403);
      answers.push(refusal(res, handle));
    }
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    expect(answers[0]?.code).toBe("cant_wake");
    // A refusal writes nothing and uses no quota.
    expect(await count("nudges")).toBe(0);
    const [rl] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM rate_limits WHERE bucket LIKE 'nudge:%'`;
    expect(rl?.n).toBe(0);
    // And none of them shows in the holder's list.
    for (const b of [bob, carol, erin])
      expect(
        (await grants({ ...b, key: b === erin ? rot.body.api_key : b.key }))
          .body.wake_grants,
      ).toEqual([]);
  });

  it("stop for good once the holder blocks the bot, until a new pass", async () => {
    const table = await register("dinner-table");
    const alice = await register("alice");
    await letWake(alice, table);
    await block(alice, table.handle);
    await unblock(alice, table.handle);
    expect((await nudge(table, alice.handle)).status).toBe(403);
    // A new pass with wake on, after the unblock, gives leave again.
    await letWake(alice, table);
    expect((await nudge(table, alice.handle)).status).toBe(200);
  });

  it("stop when the leave runs out", async () => {
    const table = await register("dinner-table");
    const alice = await register("alice");
    await letWake(alice, table);
    await db().begin(async (tx) => {
      await tx`ALTER TABLE wake_grants DISABLE TRIGGER wake_grants_append_only`;
      await tx`UPDATE wake_grants SET created_at = created_at - interval '25 hours',
        expires_at = expires_at - interval '25 hours'`;
      await tx`ALTER TABLE wake_grants ENABLE TRIGGER wake_grants_append_only`;
    });
    expect((await nudge(table, alice.handle)).body.error.code).toBe(
      "cant_wake",
    );
    expect((await grants(alice)).body.wake_grants).toEqual([]);
  });

  it("stop when the holder's key is revoked, or the waker is frozen", async () => {
    const table = await register("dinner-table");
    const alice = await register("alice");
    const bob = await register("bob");
    await letWake(alice, table);
    await letWake(bob, table);
    await setFrozen(db(), table.handle, true, "Test.");
    // A frozen bot can't use its key at all.
    expect((await nudge(table, bob.handle)).status).toBe(403);
    await setFrozen(db(), table.handle, false, "Test.");
    expect((await nudge(table, bob.handle)).status).toBe(200);
    expect((await call(revokeRoute, { key: alice.key, body: {} })).status).toBe(
      200,
    );
    expect((await nudge(table, alice.handle)).body.error.code).toBe(
      "cant_wake",
    );
  });

  it("are held to an hourly limit per bot and per pair", async () => {
    await awayFromWindowEdge(3600);
    const table = await register("dinner-table");
    const alice = await register("alice");
    const bob = await register("bob");
    await letWake(alice, table);
    await letWake(bob, table);
    const [ids] = await db()<{ t: string; a: string }[]>`
      SELECT (SELECT id FROM bots WHERE handle = 'dinner-table') AS t,
             (SELECT id FROM bots WHERE handle = 'alice') AS a`;
    const fill = (bucket: string, n: number) => db()`
      INSERT INTO rate_limits (bucket, window_start, count)
      VALUES (${bucket}, to_timestamp(floor(extract(epoch FROM now()) / 3600) * 3600), ${n})
      ON CONFLICT (bucket, window_start) DO UPDATE SET count = ${n}`;
    await fill(`nudge:${ids?.t}:${ids?.a}`, LIMITS.nudgePairPerHour.limit);
    const capped = await nudge(table, alice.handle);
    expect(capped.status).toBe(429);
    expect(capped.body.error.code).toBe("rate_limited");
    // The pair's cap leaves the table's other players alone.
    expect((await nudge(table, bob.handle)).status).toBe(200);
    await fill(`nudge:${ids?.t}`, LIMITS.nudgePerHour.limit);
    expect((await nudge(table, bob.handle)).status).toBe(429);
    expect(await count("nudges")).toBe(1);
  });

  it("can be held back by the nudge gate", async () => {
    const table = await register("dinner-table");
    const alice = await register("alice");
    await letWake(alice, table);
    await setGates(db(), { nudge: [{ signal: "claimed", is: true }] }, "Test.");
    const res = await nudge(table, alice.handle);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("not_yet");
    // Held back first, so a gated bot learns nothing about who it could wake.
    expect((await nudge(table, "nobody-here")).body.error.code).toBe("not_yet");
  });

  it("stop under the kill switch; listing still works", async () => {
    const table = await register("dinner-table");
    const alice = await register("alice");
    await letWake(alice, table);
    process.env.UNPROMPTED_READ_ONLY = "1";
    expect((await nudge(table, alice.handle)).status).toBe(503);
    expect((await end(alice, table.handle)).status).toBe(503);
    expect((await grants(alice)).body.wake_grants).toHaveLength(1);
  });

  it("are refused by the database too, and never change", async () => {
    const table = await register("dinner-table");
    const alice = await register("alice");
    await expect(
      db()`INSERT INTO nudges (bot_id, to_bot_id)
        SELECT t.id, a.id FROM bots t, bots a
        WHERE t.handle = 'dinner-table' AND a.handle = 'alice'`,
    ).rejects.toMatchObject({ code: "UPN01" });
    await letWake(alice, table);
    await nudge(table, alice.handle);
    await expect(db()`UPDATE nudges SET ref = 'x'`).rejects.toThrow();
    await expect(db()`DELETE FROM nudges`).rejects.toThrow();
    await expect(
      db()`UPDATE wake_grants SET expires_at = now() + interval '1 hour'`,
    ).rejects.toThrow();
    await expect(db()`DELETE FROM wake_grants`).rejects.toThrow();
    // Leave is given only with the holder's own live key, never longer
    // than a day and an hour.
    await expect(
      db()`INSERT INTO wake_grants (bot_id, by_bot_id, key_id, expires_at)
        SELECT a.id, t.id, k.id, now() + interval '1 hour'
        FROM bots a, bots t, api_keys k
        WHERE a.handle = 'alice' AND t.handle = 'dinner-table' AND k.bot_id = t.id`,
    ).rejects.toThrow(/own live key/);
    await expect(
      db()`INSERT INTO wake_grants (bot_id, by_bot_id, key_id, expires_at)
        SELECT a.id, t.id, k.id, now() + interval '3 days'
        FROM bots a, bots t, api_keys k
        WHERE a.handle = 'alice' AND t.handle = 'dinner-table' AND k.bot_id = a.id`,
    ).rejects.toThrow(/check/);
  });
});

describe("taking leave back", () => {
  it("is safe to repeat and writes only when there's leave to end", async () => {
    const table = await register("dinner-table");
    const alice = await register("alice");
    await letWake(alice, table);
    const first = await end(alice, `@${table.handle}`);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ bot: table.handle, ended: true });
    const rows = await count("wake_grants");
    const again = await end(alice, table.handle);
    expect(again.body).toEqual(first.body);
    // Unknown, self and never-given answer the same, and write nothing.
    expect((await end(alice, "nobody-here")).body.ended).toBe(true);
    expect((await end(alice, alice.handle)).body.ended).toBe(true);
    expect(await count("wake_grants")).toBe(rows);
    const [log] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM action_log WHERE action = 'wake_grant.end'`;
    expect(log?.n).toBe(1);
  });
});

describe("what's new", () => {
  it("says which bot nudged, so a risen number has a reason", async () => {
    const table = await register("dinner-table");
    const quiz = await register("quiz-table");
    const alice = await register("alice");
    await letWake(alice, table);
    await letWake(alice, quiz);
    await nudge(table, alice.handle, "m_1");
    await nudge(table, alice.handle, "m_2");
    await nudge(quiz, alice.handle);
    const d = await call(digestRoute, {
      key: alice.key,
      path: "/v1/me/digest",
    });
    expect(d.status).toBe(200);
    expect(d.body.nudges).toEqual([
      { from: quiz.handle, ref: null, at: expect.any(String) },
      { from: table.handle, ref: "m_2", at: expect.any(String) },
    ]);
    // Leave taken back drops the bot from what's new.
    await end(alice, quiz.handle);
    const d2 = await call(digestRoute, {
      key: alice.key,
      path: "/v1/me/digest",
    });
    expect(d2.body.nudges.map((n: { from: string }) => n.from)).toEqual([
      table.handle,
    ]);
  });
});

describe("moderators' lookup", () => {
  it("counts leave and nudges, never who with", async () => {
    const table = await register("dinner-table");
    const alice = await register("alice");
    await letWake(alice, table);
    await nudge(table, alice.handle, "m_1");
    await end(alice, table.handle);
    const a = await lookupBot(db(), alice.handle);
    expect(a?.messages).toMatchObject({
      wake_grants_given: 1,
      nudges_sent: 0,
      nudges_received: 1,
    });
    const t = await lookupBot(db(), table.handle);
    expect(t?.messages).toMatchObject({
      wake_grants_given: 0,
      nudges_sent: 1,
      nudges_received: 0,
    });
    expect(JSON.stringify(a)).not.toContain("m_1");
  });
});

describe("the API description", () => {
  it("lists the nudge routes", () => {
    expect(OPERATIONS["/v1/nudges"]?.post).toBeDefined();
    expect(OPERATIONS["/v1/me/wake-grants"]?.get).toBeDefined();
    expect(OPERATIONS["/v1/me/wake-grants/end"]?.post).toBeDefined();
  });
});

describe("the connector", () => {
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
    const result = (await (await mcpRoute(req, undefined as never)).json())
      .result;
    const text = (result?.content?.[0]?.text ?? "") as string;
    // biome-ignore lint/suspicious/noExplicitAny: test reads JSON
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { isError: result?.isError === true, data };
  }

  it("gives, uses, lists and ends leave the same way", async () => {
    const table = await register("dinner-table");
    const alice = await register("alice");
    const p = await tool(alice.key, "get_pass", {
      to: table.handle,
      wake: true,
    });
    expect(p.isError).toBe(false);
    expect(p.data.wake).toBe(true);
    expect(p.data.note).toContain("end_wake_grant");
    const r = await tool(table.key, "redeem_pass", { pass: p.data.pass });
    expect(r.data.wake_until).toEqual(expect.any(String));
    const n = await tool(table.key, "nudge", { to: alice.handle, ref: "m_1" });
    expect(n.isError).toBe(false);
    expect(n.data.nudged.to).toBe(alice.handle);
    expect(await wakeOf(alice)).toBe(1);
    const l = await tool(alice.key, "list_wake_grants");
    expect(l.data.wake_grants[0]).toMatchObject({
      bot: table.handle,
      last_nudge: { ref: "m_1" },
    });
    const e = await tool(alice.key, "end_wake_grant", { bot: table.handle });
    expect(e.data).toEqual({ bot: table.handle, ended: true });
    const refused = await tool(table.key, "nudge", { to: alice.handle });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.data)).toContain("cant_wake");
  });
});
