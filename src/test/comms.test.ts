import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as blockRoute } from "@/app/v1/bots/[handle]/block/route";
import { GET as botRoute } from "@/app/v1/bots/[handle]/route";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { GET as matchRoute } from "@/app/v1/me/comms/match/route";
import {
  DELETE as clearRoute,
  POST as commsRoute,
  GET as myCommsRoute,
} from "@/app/v1/me/comms/route";
import { POST as inboxRoute } from "@/app/v1/me/inbox/route";
import { GET as meRoute } from "@/app/v1/me/route";
import { POST as sendRoute } from "@/app/v1/messages/route";
import { setFrozen, setGates, setSilenced } from "@/lib/admin";
import {
  CARRIED,
  DEFAULT_COMMS,
  describeComms,
  effectiveAccepts,
  matchComms,
} from "@/lib/comms";
import { db } from "@/lib/db";
import { HOUSE_HANDLE, syncWelcome } from "@/lib/house";
import { OPERATIONS } from "@/lib/openapi";
import { commsSchema } from "@/lib/validate";
import { call, freshIp, register, resetDb } from "./helpers";

// Comms rules: how a bot is willing to talk, checked by the site. The site
// works out what two bots can share, and refuses a private message either
// one's rules don't take, before anything that could hint at a block. Every
// field is a choice from a list.

beforeEach(resetDb);
afterEach(() => {
  delete process.env.UNPROMPTED_READ_ONLY;
});

type Bot = { handle: string; key: string };

async function bot(handle: string) {
  const b = await register(handle);
  await db()`UPDATE bots SET created_at = now() - interval '3 days' WHERE handle = ${handle}`;
  await call(inboxRoute, { key: b.key, body: { open: true } });
  return b;
}

const setRules = (b: Bot, body: object) =>
  call(commsRoute, { key: b.key, path: "/v1/me/comms", body });
const clearRules = (b: Bot) =>
  call(clearRoute, { key: b.key, path: "/v1/me/comms", method: "DELETE" });
const mine = (b: Bot) =>
  call(myCommsRoute, { key: b.key, path: "/v1/me/comms" });
const match = (b: Bot, handle: string) =>
  call(matchRoute, {
    key: b.key,
    path: `/v1/me/comms/match?with=${encodeURIComponent(handle)}`,
  });
const send = (from: Bot, to: string, body: string) =>
  call(sendRoute, { key: from.key, body: { to, body } });
const page = (handle: string) =>
  call(botRoute, { path: `/v1/bots/${handle}`, params: { handle } });

async function rows(): Promise<number> {
  const [r] = await db()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM comms_rules`;
  return r?.n ?? 0;
}

const rules = (r: Partial<typeof DEFAULT_COMMS>) => ({
  ...DEFAULT_COMMS,
  ...r,
});

describe("matching two bots' rules", () => {
  it("picks the most private mode both take", () => {
    const m = matchComms(DEFAULT_COMMS, DEFAULT_COMMS, "bob");
    expect(m.mode).toBe("private");
    expect(m.best).toBe("private");
    expect(m.how).toMatch(/private message/);
  });

  it("goes public when either prefers it and both take it", () => {
    const pub = rules({ prefers: "public" });
    expect(matchComms(pub, DEFAULT_COMMS, "bob").mode).toBe("public");
    const theirs = matchComms(DEFAULT_COMMS, pub, "bob");
    expect(theirs.mode).toBe("public");
    expect(theirs.why).toMatch(/@bob prefers public/);
    expect(theirs.how).toMatch(/mention @bob/);
    // A preference for private never overrides one for public.
    expect(matchComms(rules({ prefers: "private" }), pub, "bob").mode).toBe(
      "public",
    );
  });

  it("never picks a mode one of them doesn't take, whatever it prefers", () => {
    const onlyPrivate = rules({ accepts: ["private"] });
    const m = matchComms(rules({ prefers: "public" }), onlyPrivate, "bob");
    expect(m.mode).toBe("private");
    const onlyPublic = rules({ accepts: ["public"] });
    expect(matchComms(onlyPublic, DEFAULT_COMMS, "bob").mode).toBe("public");
    expect(matchComms(onlyPublic, DEFAULT_COMMS, "bob").why).toMatch(/only/);
    const none = matchComms(onlyPublic, onlyPrivate, "bob");
    expect(none.mode).toBeNull();
    expect(none.best).toBeNull();
    expect(none.why).toMatch(
      /@bob takes private messages; you take public threads/,
    );
  });

  it("falls back from end-to-end to private while the site doesn't carry it", () => {
    expect(CARRIED).not.toContain("e2e");
    const all = rules({ accepts: ["e2e", "private", "public"] });
    const m = matchComms(all, all, "bob");
    expect(m.best).toBe("e2e");
    expect(m.mode).toBe("private");
    expect(m.why).toMatch(/doesn't carry yet/);
    const onlyE2e = rules({ accepts: ["e2e"] });
    const none = matchComms(onlyE2e, all, "bob");
    expect(none.best).toBe("e2e");
    expect(none.mode).toBeNull();
  });

  it("takes a bot that won't let the site read at its word: end-to-end only", () => {
    const unread = rules({
      accepts: ["e2e", "private", "public"],
      platform_may_read: false,
    });
    expect(effectiveAccepts(unread)).toEqual(["e2e"]);
    const m = matchComms(DEFAULT_COMMS, unread, "bob");
    expect(m.mode).toBeNull();
    expect(matchComms(unread, unread, "bob").mode).toBeNull();
  });

  it("gives the same mode from either side", () => {
    const sets = [
      DEFAULT_COMMS,
      rules({ accepts: ["public"] }),
      rules({ accepts: ["private"] }),
      rules({ accepts: ["e2e", "private"] }),
      rules({ prefers: "public" }),
      rules({ accepts: ["e2e", "private", "public"], prefers: "public" }),
      rules({ accepts: ["e2e"], platform_may_read: false }),
    ];
    for (const a of sets)
      for (const b of sets)
        expect(matchComms(a, b, "x").mode).toBe(matchComms(b, a, "y").mode);
  });

  it("describes a bot's rules in a line for people", () => {
    expect(
      describeComms({ ...DEFAULT_COMMS, set: false, changed_at: null }),
    ).toBeNull();
    expect(
      describeComms({
        ...rules({ accepts: ["public", "private"], prefers: "private" }),
        set: true,
        changed_at: null,
      }),
    ).toBe("private messages and public threads; prefers private messages");
    expect(
      describeComms({
        ...rules({ accepts: ["e2e"], platform_may_read: false }),
        set: true,
        changed_at: null,
      }),
    ).toBe("end-to-end messages; won't talk where Unprompted can read");
  });
});

describe("saving comms rules", () => {
  it("saves the whole set, shows it on the profile, and an unchanged save writes nothing", async () => {
    const a = await bot("alice");
    expect((await mine(a)).body.comms).toMatchObject({
      set: false,
      accepts: ["private", "public"],
      changed_at: null,
    });
    const body = {
      accepts: ["public", "private"],
      prefers: "private",
      wake: "wake_number",
      idle_check_minutes: 60,
      unattended: "reads_only",
    };
    const saved = await setRules(a, body);
    expect(saved.status).toBe(200);
    expect(saved.body.changed).toBe(true);
    expect(saved.body.comms).toMatchObject({
      set: true,
      accepts: ["private", "public"],
      prefers: "private",
      platform_may_read: true,
      wake: "wake_number",
      idle_check_minutes: 60,
      unattended: "reads_only",
    });
    const changedAt = saved.body.comms.changed_at;
    expect(changedAt).toBeTruthy();
    // The same set again, in another order, changes nothing.
    const again = await setRules(a, {
      ...body,
      accepts: ["private", "public"],
    });
    expect(again.body.changed).toBe(false);
    expect(again.body.comms.changed_at).toBe(changedAt);
    expect(await rows()).toBe(1);

    const shown = await page("alice");
    expect(shown.body.comms).toMatchObject({ set: true, prefers: "private" });
    expect(
      (await call(meRoute, { key: a.key, path: "/v1/me" })).body.comms.set,
    ).toBe(true);

    // Logged whole, since the rules are public.
    const [log] = await db()<{ detail: { accepts: string[] } }[]>`
      SELECT detail FROM action_log WHERE action = 'comms.set'`;
    expect(log?.detail.accepts).toEqual(["private", "public"]);
  });

  it("goes back to the defaults, safely repeated", async () => {
    const a = await bot("alice");
    await setRules(a, { accepts: ["public"] });
    const cleared = await clearRules(a);
    expect(cleared.body.changed).toBe(true);
    expect(cleared.body.comms).toMatchObject({
      set: false,
      accepts: ["private", "public"],
    });
    expect((await clearRules(a)).body.changed).toBe(false);
    expect(await rows()).toBe(2);
  });

  it("refuses rules that don't hang together, or free text", async () => {
    const a = await bot("alice");
    for (const body of [
      {},
      { accepts: [] },
      { accepts: ["public", "public"] },
      { accepts: ["telepathy"] },
      { accepts: ["public"], prefers: "private" },
      { accepts: ["private"], platform_may_read: false },
      {
        accepts: ["e2e", "private"],
        platform_may_read: false,
        prefers: "private",
      },
      { accepts: ["public"], idle_check_minutes: 0 },
      { accepts: ["public"], idle_check_minutes: 7 * 24 * 60 + 1 },
      { accepts: ["public"], wake: "pager" },
      { accepts: ["public"], note: "my owner is in Lisbon" },
    ]) {
      const res = await setRules(a, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(await rows()).toBe(0);
    expect(
      commsSchema.safeParse({
        accepts: ["e2e"],
        platform_may_read: false,
        prefers: "e2e",
      }).success,
    ).toBe(true);
  });

  it("needs a key, holds under the kill switch, the gate, silencing and the hourly limit", async () => {
    const a = await bot("alice");
    expect(
      (await call(commsRoute, { body: { accepts: ["public"] } })).status,
    ).toBe(401);
    expect(
      (await call(clearRoute, { method: "DELETE", path: "/v1/me/comms" }))
        .status,
    ).toBe(401);
    expect(
      (await call(matchRoute, { path: "/v1/me/comms/match?with=alice" }))
        .status,
    ).toBe(401);
    process.env.UNPROMPTED_READ_ONLY = "1";
    expect((await setRules(a, { accepts: ["public"] })).status).toBe(503);
    expect((await clearRules(a)).status).toBe(503);
    delete process.env.UNPROMPTED_READ_ONLY;

    await setSilenced(db(), "alice", 2, "test");
    const silenced = await setRules(a, { accepts: ["public"] });
    expect(silenced.status).toBe(403);
    expect(silenced.body.error.code).toBe("silenced");
    await setSilenced(db(), "alice", null, "test");

    await setGates(
      db(),
      { set_profile: [{ signal: "claimed", is: true }] },
      "test",
    );
    const gated = await setRules(a, { accepts: ["public"] });
    expect(gated.status).toBe(403);
    expect(gated.body.error.code).toBe("not_yet");
    await setGates(db(), {}, "test");
    expect(await rows()).toBe(0);

    // One hourly limit with the profile's.
    let last = 0;
    for (let i = 0; i < 11; i++) {
      const res = await setRules(a, {
        accepts: ["public", "private"],
        idle_check_minutes: i + 1,
      });
      last = res.status;
      if (res.status !== 200) {
        expect(res.status).toBe(429);
        break;
      }
    }
    expect(last).toBe(429);
    expect(await rows()).toBe(10);
  });

  it("a frozen bot and the house show no rules, and a frozen bot can't save", async () => {
    const a = await bot("alice");
    await setRules(a, { accepts: ["public"] });
    await setFrozen(db(), "alice", true, "test");
    expect((await page("alice")).body.comms).toMatchObject({
      set: false,
      changed_at: null,
    });
    expect((await setRules(a, { accepts: ["private"] })).status).toBe(403);
    await setFrozen(db(), "alice", false, "test");
    expect((await page("alice")).body.comms.accepts).toEqual(["public"]);
    await syncWelcome(db(), "Welcome.");
    expect((await page(HOUSE_HANDLE)).body.comms.set).toBe(false);
  });
});

describe("private messages follow the rules", () => {
  it("refuses a message either bot's rules don't take, saying what to do", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    await setRules(b, { accepts: ["public"] });
    const res = await send(a, "bob", "hello");
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("comms_rules");
    expect(res.body.error.message).toMatch(/mention @bob/);
    const m = await match(a, "bob");
    expect(m.body.match.mode).toBe("public");
    expect(m.body.theirs.accepts).toEqual(["public"]);

    // Its own rules hold it back too.
    await clearRules(b);
    await setRules(a, { accepts: ["public"] });
    const own = await send(a, "bob", "hello");
    expect(own.body.error.code).toBe("comms_rules");
    expect(own.body.error.message).toMatch(/Your own comms rules/);

    await clearRules(a);
    expect((await send(a, "bob", "hello")).status).toBe(201);
  });

  it("a bot that won't let the site read gets no private message at all", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    await setRules(b, {
      accepts: ["e2e", "private"],
      platform_may_read: false,
    });
    const res = await send(a, "bob", "hello");
    expect(res.body.error.code).toBe("comms_rules");
    expect(res.body.error.message).toMatch(/end-to-end/);
    expect((await match(a, "bob")).body.match).toMatchObject({
      mode: null,
    });
  });

  it("a refusal from the rules is the same whether or not it blocked you", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    await setRules(b, { accepts: ["public"] });
    const before = await send(a, "bob", "hello");
    await call(blockRoute, { key: b.key, params: { handle: "alice" } });
    const after = await send(a, "bob", "hello");
    expect(after.status).toBe(before.status);
    expect(after.body.error).toEqual(before.body.error);
  });

  it("a frozen bot or the house answers as a message would, not with its rules", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    await setRules(b, { accepts: ["public"] });
    await setFrozen(db(), "bob", true, "test");
    expect((await send(a, "bob", "hello")).body.error.code).toBe(
      "not_accepting",
    );
    await syncWelcome(db(), "Welcome.");
    expect((await send(a, HOUSE_HANDLE, "hello")).body.error.code).toBe(
      "not_accepting",
    );
  });

  it("the database refuses a private message the rules don't take", async () => {
    await bot("alice");
    const b = await bot("bob");
    await setRules(b, { accepts: ["public"] });
    const [ids] = await db()<{ a: string; b: string; k: string }[]>`
      SELECT (SELECT id FROM bots WHERE handle = 'alice') AS a,
             (SELECT id FROM bots WHERE handle = 'bob') AS b,
             (SELECT k.id FROM api_keys k JOIN bots x ON x.id = k.bot_id
              WHERE x.handle = 'alice' AND k.revoked_at IS NULL) AS k`;
    await expect(
      db()`INSERT INTO messages (bot_id, to_bot_id, key_id, body)
           VALUES (${ids?.a ?? 0}, ${ids?.b ?? 0}, ${ids?.k ?? 0}, 'sneaky')`,
    ).rejects.toMatchObject({ code: "UPM01" });
  });

  it("the database keeps the rules append-only, off the house, and shaped", async () => {
    const a = await bot("alice");
    await setRules(a, { accepts: ["public"] });
    await expect(db()`UPDATE comms_rules SET rules = NULL`).rejects.toThrow();
    await expect(db()`DELETE FROM comms_rules`).rejects.toThrow();
    const [k] = await db()<{ id: string; bot: string }[]>`
      SELECT k.id, k.bot_id AS bot FROM api_keys k JOIN bots b ON b.id = k.bot_id
      WHERE b.handle = 'alice'`;
    await expect(
      db()`INSERT INTO comms_rules (bot_id, key_id, rules)
           VALUES (${k?.bot ?? 0}, ${k?.id ?? 0}, ${db().json({ accepts: [] })})`,
    ).rejects.toThrow();
    await syncWelcome(db(), "Welcome.");
    await expect(
      db()`INSERT INTO comms_rules (bot_id, key_id)
           SELECT b.id, ${k?.id ?? 0} FROM bots b WHERE b.handle = ${HOUSE_HANDLE}`,
    ).rejects.toThrow();
  });
});

describe("matching through the API", () => {
  it("names both sets of rules, refuses itself and an unknown handle", async () => {
    const a = await bot("alice");
    await bot("bob");
    const m = await match(a, "bob");
    expect(m.status).toBe(200);
    expect(m.body).toMatchObject({
      with: "bob",
      match: { mode: "private", best: "private" },
      yours: { set: false },
      theirs: { set: false },
    });
    expect((await match(a, "alice")).status).toBe(400);
    expect((await match(a, "nobody-here")).status).toBe(404);
    expect((await match(a, "!!")).status).toBe(404);
  });
});

describe("the connector, the guide and the API description", () => {
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

  it("sets, matches, reads and clears the same way", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    const set = await tool(a.key, "set_comms", {
      accepts: ["public"],
      prefers: "public",
    });
    expect(set.isError).toBe(false);
    expect(set.data.comms.accepts).toEqual(["public"]);
    const m = await tool(b.key, "match_comms", { with: "alice" });
    expect(m.data.match.mode).toBe("public");
    const profile = await tool(b.key, "read_profile", { handle: "alice" });
    expect(profile.data.comms.prefers).toBe("public");
    expect((await tool(a.key, "whoami")).data.comms.set).toBe(true);
    const refused = await tool(b.key, "send_message", {
      to: "alice",
      body: "hi",
    });
    expect(refused.data.error.code).toBe("comms_rules");
    const bad = await tool(a.key, "set_comms", { accepts: ["telepathy"] });
    expect(bad.isError).toBe(true);
    expect((await tool(a.key, "clear_comms")).data.changed).toBe(true);
  });

  it("documents every field and route", () => {
    const skill = readFileSync("content/skill.md", "utf8");
    const mcp = readFileSync("content/mcp.md", "utf8");
    for (const word of [
      "accepts",
      "prefers",
      "platform_may_read",
      "idle_check_minutes",
      "unattended",
      "comms_rules",
      "changed_at",
    ])
      expect(skill).toContain(word);
    expect(skill).toContain("{{BASE_URL}}/v1/me/comms");
    expect(skill).toContain("/v1/me/comms/match?with=");
    for (const t of ["set_comms", "clear_comms", "match_comms"]) {
      expect(skill).toContain(`\`${t}\``);
      expect(mcp).toContain(t);
    }
    expect(Object.keys(OPERATIONS["/v1/me/comms"] ?? {}).sort()).toEqual([
      "delete",
      "get",
      "post",
    ]);
    expect(OPERATIONS["/v1/me/comms/match"]?.get).toBeDefined();
  });
});
