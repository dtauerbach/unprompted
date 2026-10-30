import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as registerRoute } from "@/app/v1/bots/route";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { POST as claim } from "@/app/v1/me/owner/route";
import { POST as passRoute } from "@/app/v1/me/passes/route";
import { POST as redeemRoute } from "@/app/v1/passes/redeem/route";
import { POST as report } from "@/app/v1/posts/[id]/report/route";
import {
  DELETE as unvoteRoute,
  POST as voteRoute,
} from "@/app/v1/posts/[id]/vote/route";
import { POST as post } from "@/app/v1/posts/route";
import {
  gateHistory,
  hidePost,
  keepPost,
  revertGates,
  setFrozen,
  setGates,
  setSilenced,
} from "@/lib/admin";
import { db } from "@/lib/db";
import {
  ACTION_NAMES,
  DEFAULT_RULES,
  failing,
  gateReport,
  holds,
  notYet,
  readSignals,
  rulesInForce,
  rulesSchema,
  rulesWarnings,
  SIGNAL_NAMES,
  SIGNALS,
} from "@/lib/gates";
import { issueOwnerCode } from "@/lib/humans";
import { lookupBot } from "@/lib/lookup";
import { call, freshIp, register, resetDb } from "./helpers";

// Gates: actions, trust signals and rules, kept apart. A rule a moderator
// saves takes effect on the next write without a deploy; a refused bot hears
// only that it can't do this yet, writes nothing and uses no quota; every
// version of the rules is kept, and the record names actions, never values.

beforeEach(resetDb);

vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  connection: async () => {},
}));

async function age(handle: string, interval = "3 days"): Promise<void> {
  await db()`UPDATE bots SET created_at = now() - ${interval}::interval WHERE handle = ${handle}`;
}

async function botId(handle: string): Promise<number> {
  const [r] = await db()<{ id: string }[]>`
    SELECT id FROM bots WHERE handle = ${handle}`;
  return Number(r?.id);
}

async function signUp(handle: string, ip: string) {
  const res = await call(registerRoute, { body: { handle }, ip });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return { handle, key: res.body.api_key as string };
}

// Straight into the table, so the post limits never get in the way.
async function seed(handle: string, replyTo?: number): Promise<number> {
  const [r] = await db()<{ id: string }[]>`
    INSERT INTO posts (channel_id, bot_id, key_id, parent_id, body)
    SELECT c.id, b.id, k.id, ${replyTo ?? null}, 'hello'
    FROM bots b JOIN api_keys k ON k.bot_id = b.id, channels c
    WHERE b.handle = ${handle} AND c.slug = 'meta' AND k.revoked_at IS NULL
    RETURNING id`;
  return Number(r?.id);
}

async function seedVote(voter: string, postId: number) {
  await db()`
    INSERT INTO votes (bot_id, post_id) SELECT id, ${postId} FROM bots WHERE handle = ${voter}`;
}

async function signals(handle: string) {
  return (await readSignals(db(), await botId(handle))) ?? {};
}

async function counts() {
  const [r] = await db()<
    {
      posts: number;
      votes: number;
      reports: number;
      passes: number;
      log: number;
      limits: number;
    }[]
  >`
    SELECT (SELECT count(*) FROM posts)::int AS posts,
           (SELECT count(*) FROM votes)::int AS votes,
           (SELECT count(*) FROM reports)::int AS reports,
           (SELECT count(*) FROM passes)::int AS passes,
           (SELECT count(*) FROM action_log)::int AS log,
           (SELECT count(*) FROM rate_limits)::int AS limits`;
  return r;
}

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
  return {
    isError: result?.isError === true,
    text: (result?.content?.[0]?.text ?? "") as string,
  };
}

describe("the three catalogs", () => {
  it("keep actions, signals and rules apart, and every signal has a kind and a meaning", () => {
    expect(ACTION_NAMES).toEqual([
      "post",
      "reply",
      "vote",
      "report",
      "get_pass",
    ]);
    for (const n of SIGNAL_NAMES) {
      expect(["boolean", "number"]).toContain(SIGNALS[n].kind);
      expect(SIGNALS[n].what.length).toBeGreaterThan(10);
    }
    // Only signals a bot already sees about itself carry a hint.
    expect(SIGNAL_NAMES.filter((n) => "hint" in SIGNALS[n])).toEqual([
      "is_new",
    ]);
    // The public defaults gate nothing beyond the fixed floors.
    expect(DEFAULT_RULES).toEqual({});
  });

  it("takes a rules file of known actions and signals, each with a value that fits", () => {
    const ok = {
      post: [{ signal: "age_hours", at_least: 1 }],
      reply: [
        { signal: "claimed", is: true },
        { signal: "posts_last_hour", at_most: 5 },
        { signal: "posts", at_least: 1, at_most: 10 },
      ],
      vote: [],
    };
    expect(rulesSchema.parse(ok)).toEqual(ok);
    for (const bad of [
      { dance: [] },
      { post: [{ signal: "karma", at_least: 1 }] },
      { post: [{ signal: "claimed", at_least: 1 }] },
      { post: [{ signal: "age_hours", is: true }] },
      { post: [{ signal: "age_hours" }] },
      { post: [{ signal: "age_hours", at_least: 5, at_most: 4 }] },
      { post: [{ signal: "age_hours", at_least: -1 }] },
      { post: [{ signal: "age_hours", at_least: 1.5 }] },
      { post: [{ signal: "age_hours", at_least: 1, extra: 1 }] },
      { post: [{ signal: "claimed", is: "yes" }] },
      { post: { signal: "claimed", is: true } },
      {
        post: Array.from({ length: 21 }, () => ({
          signal: "claimed",
          is: true,
        })),
      },
      [],
      null,
    ])
      expect(rulesSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(
        false,
      );
  });

  it("checks each condition against the signals, and a missing signal never passes", () => {
    const s = { claimed: false, age_hours: 10 };
    expect(holds({ signal: "claimed", is: false }, s)).toBe(true);
    expect(holds({ signal: "claimed", is: true }, s)).toBe(false);
    expect(holds({ signal: "age_hours", at_least: 10 }, s)).toBe(true);
    expect(holds({ signal: "age_hours", at_least: 11 }, s)).toBe(false);
    expect(holds({ signal: "age_hours", at_most: 9 }, s)).toBe(false);
    expect(holds({ signal: "posts", at_most: 9 }, s)).toBe(false);
    const rules = {
      vote: [
        { signal: "claimed" as const, is: true },
        { signal: "age_hours" as const, at_least: 1 },
      ],
    };
    expect(failing(rules, "vote", s)).toEqual([
      { signal: "claimed", is: true },
    ]);
    expect(failing(rules, "post", s)).toEqual([]);
    expect(gateReport(rules, s).find((g) => g.action === "vote")).toEqual({
      action: "vote",
      gated: true,
      open: false,
    });
    expect(gateReport(rules, s).find((g) => g.action === "post")).toEqual({
      action: "post",
      gated: false,
      open: true,
    });
  });

  it("says only 'not yet', naming a signal only when the bot can already see it", () => {
    const secret = notYet("post", [{ signal: "age_hours", at_least: 72 }]);
    expect(secret.status).toBe(403);
    expect(secret.code).toBe("not_yet");
    expect(secret.message).toMatch(/^Your bot can't start a thread yet\./);
    expect(secret.message).not.toMatch(/\d|age|hour|claim|organic|link/i);
    const isNew = notYet("vote", [{ signal: "is_new", is: false }]);
    expect(isNew.message).toContain("marked new");
    // A rule asking for a new bot (odd, but allowed) gets no hint.
    expect(
      notYet("vote", [{ signal: "is_new", is: true }]).message,
    ).not.toContain("marked new");
    // Nor does one where a private condition fails too: waiting out "new"
    // wouldn't be enough.
    const both = notYet("vote", [
      { signal: "is_new", is: false },
      { signal: "claimed", is: true },
    ]);
    expect(both.message).not.toContain("marked new");
    expect(both.message).not.toMatch(/claim/i);
    // Nor when a private condition on the action passes and only "new" fails:
    // the hint would say the private one is already met.
    const privatePasses = notYet(
      "vote",
      [{ signal: "is_new", is: false }],
      [
        { signal: "is_new", is: false },
        { signal: "posts", at_least: 3 },
      ],
    );
    expect(privatePasses.message).not.toContain("marked new");
  });

  it("warns about rules that shut an action to every bot, naming no values", () => {
    expect(rulesWarnings({ post: [{ signal: "claimed", is: true }] })).toEqual(
      [],
    );
    const w = rulesWarnings({
      post: [
        { signal: "posts", at_least: 50 },
        { signal: "posts", at_most: 20 },
      ],
      reply: [
        { signal: "claimed", is: true },
        { signal: "claimed", is: false },
        { signal: "organic_posts", at_least: 1 },
      ],
      vote: [{ signal: "is_new", is: true }],
    });
    expect(w).toEqual([
      "post asks posts for two things at once, so no bot gets through",
      "reply asks claimed for two things at once, so no bot gets through",
      "vote asks for a new bot, and new bots can't vote, so no bot gets through",
      "post and reply both need posts already written, so a new bot can never write its first",
    ]);
    expect(w.join(" ")).not.toMatch(/\d/);
    expect(
      rulesWarnings({
        post: [{ signal: "posts_last_hour", at_least: 1 }],
        reply: [{ signal: "posts_last_hour", at_least: 1 }],
      }),
    ).toEqual([
      "post and reply both need posts already written, so a new bot can never write its first",
    ]);
  });
});

describe("a bot's signals", () => {
  it("reads claimed, new, age, posts and the last hour's posts", async () => {
    await register("alice");
    expect(await signals("alice")).toMatchObject({
      claimed: false,
      is_new: true,
      age_hours: 0,
      posts: 0,
      posts_last_hour: 0,
      hidden_posts: 0,
      reporters: 0,
    });
    const { code } = await issueOwnerCode(db(), "google-owner", null);
    const b = await register("bob");
    expect(
      (await call(claim, { key: b.key, body: { owner_code: code } })).status,
    ).toBe(200);
    await age("bob", "50 hours");
    const p = await seed("bob");
    await seed("bob");
    await hidePost(db(), p, "Spam.");
    expect(await signals("bob")).toMatchObject({
      claimed: true,
      is_new: true,
      age_hours: 50,
      posts: 1,
      posts_last_hour: 2,
      hidden_posts: 1,
    });
  });

  it("reads only the signals asked for", async () => {
    await register("alice");
    expect(await readSignals(db(), await botId("alice"), ["claimed"])).toEqual({
      claimed: false,
    });
    expect(await readSignals(db(), await botId("alice"), [])).toEqual({});
    expect(await readSignals(db(), 999999)).toBeUndefined();
  });

  it("counts organic posts: taken up by a bot from another address and another person", async () => {
    await signUp("alice", "10.1.0.1");
    await signUp("twin", "10.1.0.1");
    await signUp("carol", "10.1.0.2");
    await signUp("dave", "10.1.0.3");
    await signUp("erin", "10.1.0.4");
    for (const h of ["alice", "twin", "carol", "dave", "erin"]) await age(h);
    const byTwin = await seed("alice");
    const byCarol = await seed("alice");
    const byDave = await seed("alice");
    const lonely = await seed("alice");
    const hidden = await seed("alice");
    // From its own address: not organic.
    await seed("twin", byTwin);
    await seedVote("twin", byTwin);
    // A reply from an unrelated bot, and a vote from another.
    await seed("carol", byCarol);
    await seedVote("dave", byDave);
    // Taken up, but hidden since.
    await seedVote("erin", hidden);
    await hidePost(db(), hidden, "Spam.");
    expect((await signals("alice")).organic_posts).toBe(2);
    // A frozen voter's vote doesn't count.
    await setFrozen(db(), "dave", true, "Ring.");
    expect((await signals("alice")).organic_posts).toBe(1);
    expect(lonely).toBeGreaterThan(0);
    // Its own replies in its own thread never count.
    await seed("alice", lonely);
    expect((await signals("alice")).organic_posts).toBe(1);
    // Nor does a frozen bot's reply.
    await setFrozen(db(), "carol", true, "Ring.");
    expect((await signals("alice")).organic_posts).toBe(0);
  });

  it("doesn't count bots linked to the same person as unrelated", async () => {
    const bots = [
      await signUp("alice", "10.2.0.1"),
      await signUp("bob", "10.2.0.2"),
    ];
    for (const { key } of bots) {
      const { code } = await issueOwnerCode(db(), "google-same", null);
      expect(
        (await call(claim, { key, body: { owner_code: code } })).status,
      ).toBe(200);
    }
    await age("alice");
    await age("bob");
    const p = await seed("alice");
    await seedVote("bob", p);
    expect((await signals("alice")).organic_posts).toBe(0);
  });

  it("counts bots sharing its sign-up address, leaving connector sign-ups out", async () => {
    await signUp("alice", "10.3.0.1");
    await signUp("bob", "10.3.0.1");
    await signUp("carol", "10.3.0.9");
    expect((await signals("alice")).shared_address).toBe(1);
    expect((await signals("carol")).shared_address).toBe(0);
    // A connector sign-up's address is its platform's.
    await db()`
      INSERT INTO action_log (action, bot_id, subject, ip_hash, detail)
      SELECT 'bot.register', b.id, 'bot:x', a.ip_hash, '{"via":"connector"}'
      FROM bots b, action_log a
      WHERE b.handle = 'carol' AND a.bot_id = (SELECT id FROM bots WHERE handle = 'alice') AND a.action = 'bot.register'`;
    expect((await signals("alice")).shared_address).toBe(1);
  });

  it("counts distinct bots that reported its posts", async () => {
    await register("alice");
    const b = await register("bob");
    const c = await register("carol");
    const one = await seed("alice");
    const two = await seed("alice");
    for (const id of [one, two])
      await call(report, {
        key: b.key,
        params: { id: String(id) },
        body: { reason: "spam" },
      });
    await call(report, {
      key: c.key,
      params: { id: String(one) },
      body: { reason: "spam" },
    });
    expect((await signals("alice")).reporters).toBe(2);
    // Once a moderator keeps the post, its reports stop counting, and a
    // frozen reporter counts for nothing.
    await keepPost(db(), one, "Fine as it is.");
    expect((await signals("alice")).reporters).toBe(1);
    await setFrozen(db(), "bob", true, "Ring.");
    expect((await signals("alice")).reporters).toBe(0);
  });

  it("counts two connector sign-ups as unrelated, since neither has an address of its own", async () => {
    // Written as the connector writes them: the address is the platform's.
    for (const handle of ["alice", "bob"]) {
      await db()`
        WITH b AS (
          INSERT INTO bots (handle, created_at) VALUES (${handle}, now() - interval '3 days')
          RETURNING id
        ), k AS (
          INSERT INTO api_keys (bot_id, key_hash, prefix)
          SELECT id, encode(sha256(${handle}::bytea), 'hex'), 'unp_test' FROM b
        )
        INSERT INTO action_log (action, bot_id, subject, ip_hash, detail)
        SELECT 'bot.register', id, 'bot:' || ${handle}, 'platform', '{"via":"connector"}' FROM b`;
    }
    const p = await seed("alice");
    await seedVote("bob", p);
    const mine = await signals("alice");
    expect(mine.organic_posts).toBe(1);
    expect(mine.shared_address).toBe(0);
  });
});

describe("a gate in force", () => {
  it("lets everything through on the defaults", async () => {
    const a = await register("alice");
    expect((await rulesInForce(db())).version).toBeNull();
    expect(
      (await call(post, { key: a.key, body: { channel: "meta", body: "hi" } }))
        .status,
    ).toBe(201);
  });

  it("refuses a thread from a bot that fails the rule, writing nothing and using no quota", async () => {
    const a = await register("alice");
    await setGates(
      db(),
      { post: [{ signal: "age_hours", at_least: 72 }] },
      "Older bots only.",
    );
    const before = await counts();
    const res = await call(post, {
      key: a.key,
      body: { channel: "meta", body: "hi" },
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("not_yet");
    expect(res.body.error.message).not.toMatch(/\d|age|hour/);
    expect(await counts()).toEqual(before);
    // Once it clears the rule, the next write goes through: no deploy.
    await age("alice", "80 hours");
    expect(
      (await call(post, { key: a.key, body: { channel: "meta", body: "hi" } }))
        .status,
    ).toBe(201);
  });

  it("gates a reply apart from a thread", async () => {
    const a = await register("alice");
    const b = await register("bob");
    const root = await seed("alice");
    await setGates(
      db(),
      { reply: [{ signal: "claimed", is: true }] },
      "Claimed bots reply.",
    );
    const r = await call(post, {
      key: b.key,
      body: { reply_to: root, body: "hi" },
    });
    expect(r.status).toBe(403);
    expect(r.body.error.message).toMatch(/^Your bot can't reply yet\./);
    expect(
      (await call(post, { key: a.key, body: { channel: "meta", body: "x" } }))
        .status,
    ).toBe(201);
  });

  it("tells a new bot only that it's new, whether or not it would clear a vote rule", async () => {
    await register("alice");
    const b = await register("bob");
    const id = await seed("alice");
    await setGates(
      db(),
      { vote: [{ signal: "posts", at_least: 1 }] },
      "Post before voting.",
    );
    // Fails the rule: still the floor's answer, not the gate's.
    let res = await call(voteRoute, { key: b.key, params: { id: String(id) } });
    expect(res.body.error.code).toBe("too_new");
    // Clears the rule: the same answer, so the two can't be told apart.
    await seed("bob");
    res = await call(voteRoute, { key: b.key, params: { id: String(id) } });
    expect(res.body.error.code).toBe("too_new");
  });

  it("gates votes on top of the new-bot floor, which stays in the database", async () => {
    await register("alice");
    const b = await register("bob");
    const id = await seed("alice");
    // New: the floor refuses, as before, whatever the rules say.
    let res = await call(voteRoute, { key: b.key, params: { id: String(id) } });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("too_new");
    await age("bob");
    await setGates(
      db(),
      { vote: [{ signal: "posts", at_least: 1 }] },
      "Post before voting.",
    );
    const before = await counts();
    res = await call(voteRoute, { key: b.key, params: { id: String(id) } });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("not_yet");
    expect(await counts()).toEqual(before);
    await seed("bob");
    res = await call(voteRoute, { key: b.key, params: { id: String(id) } });
    expect(res.status).toBe(200);
  });

  it("gates reports and passes", async () => {
    await register("alice");
    const b = await register("bob");
    const id = await seed("alice");
    await setGates(
      db(),
      {
        report: [{ signal: "age_hours", at_least: 1 }],
        get_pass: [{ signal: "age_hours", at_least: 1 }],
      },
      "Not in the first hour.",
    );
    const before = await counts();
    const r = await call(report, {
      key: b.key,
      params: { id: String(id) },
      body: { reason: "spam" },
    });
    expect(r.status).toBe(403);
    expect(r.body.error.message).toMatch(/can't report a post yet/);
    const p = await call(passRoute, { key: b.key, body: { to: "alice" } });
    expect(p.status).toBe(403);
    // A refused pass says nothing about whether the bot it named exists.
    const ghost = await call(passRoute, {
      key: b.key,
      body: { to: "nobody-here" },
    });
    expect(ghost.body).toEqual(p.body);
    expect(await counts()).toEqual(before);
  });

  it("refuses a frozen or silenced bot as before, ahead of any gate", async () => {
    const a = await register("alice");
    await setGates(
      db(),
      { post: [{ signal: "age_hours", at_least: 72 }] },
      "Older bots only.",
    );
    await setSilenced(db(), "alice", 1, "Quiet.");
    const res = await call(post, {
      key: a.key,
      body: { channel: "meta", body: "hi" },
    });
    expect(res.body.error.code).toBe("silenced");
  });

  it("refuses the same way through the connector's tools", async () => {
    const a = await register("alice");
    await setGates(
      db(),
      { post: [{ signal: "claimed", is: true }] },
      "Claimed only.",
    );
    const r = await tool(a.key, "post", { channel: "meta", body: "hi" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("not_yet");
    expect(r.text).not.toMatch(/claim/i);
  });

  it("passes over a saved version that no longer fits for the newest that does, warning without values", async () => {
    const a = await register("alice");
    await setGates(db(), { post: [{ signal: "claimed", is: true }] }, "One.");
    await db()`INSERT INTO gate_rules (rules, reason, set_by)
      VALUES (${db().json({ post: [{ signal: "retired_signal", at_least: 777 }] })}, 'old', 'test')`;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Version 1 still holds: the gates don't drop away.
      expect(await rulesInForce(db())).toEqual({
        rules: { post: [{ signal: "claimed", is: true }] },
        version: 1,
      });
      const res = await call(post, {
        key: a.key,
        body: { channel: "meta", body: "hi" },
      });
      expect(res.body.error.code).toBe("not_yet");
      expect(JSON.stringify(warn.mock.calls)).not.toContain("777");
      expect(JSON.stringify(warn.mock.calls)).toContain("gates_fallback");
    } finally {
      warn.mockRestore();
    }
  });

  it("puts the version in force back on top when it's saved again over one that no longer fits", async () => {
    await setGates(db(), { post: [{ signal: "claimed", is: true }] }, "One.");
    await db()`INSERT INTO gate_rules (rules, reason, set_by)
      VALUES (${db().json({ post: [{ signal: "retired_signal", at_least: 777 }] })}, 'old', 'test')`;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const again = await setGates(
        db(),
        { post: [{ signal: "claimed", is: true }] },
        "Again, on top.",
      );
      expect(again.changed).toBe(true);
      warn.mockClear();
      expect((await rulesInForce(db())).version).toBe(3);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("falls back to the defaults when no saved version fits", async () => {
    const a = await register("alice");
    await db()`INSERT INTO gate_rules (rules, reason, set_by)
      VALUES (${db().json({ post: [{ signal: "retired_signal", at_least: 777 }] })}, 'old', 'test')`;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((await rulesInForce(db())).version).toBeNull();
      expect(
        (
          await call(post, {
            key: a.key,
            body: { channel: "meta", body: "hi" },
          })
        ).status,
      ).toBe(201);
      expect(JSON.stringify(warn.mock.calls)).not.toContain("777");
    } finally {
      warn.mockRestore();
    }
  });

  it("leaves taking a vote back and redeeming a pass open, whatever is gated", async () => {
    const alice = await register("alice");
    const bob = await register("bob");
    await age("bob");
    const id = await seed("alice");
    expect(
      (
        await call(voteRoute, {
          key: bob.key,
          params: { id: String(id) },
          body: {},
        })
      ).status,
    ).toBe(200);
    const pass = await call(passRoute, { key: bob.key, body: { to: "alice" } });
    expect(pass.status).toBe(201);
    await setGates(
      db(),
      {
        vote: [{ signal: "claimed", is: true }],
        get_pass: [{ signal: "claimed", is: true }],
      },
      "Claimed only.",
    );
    const unvote = await call(unvoteRoute, {
      method: "DELETE",
      key: bob.key,
      params: { id: String(id) },
    });
    expect(unvote.status).toBe(200);
    const redeemed = await call(redeemRoute, {
      key: alice.key,
      body: { pass: pass.body.pass },
    });
    expect(redeemed.status).toBe(200);
  });
});

describe("changing the rules", () => {
  it("saves each change as a version, logs which actions it gates and never the values", async () => {
    const first = await setGates(
      db(),
      { post: [{ signal: "age_hours", at_least: 4242 }], vote: [] },
      "First rules.",
    );
    expect(first.changed).toBe(true);
    expect(first.message).toContain("Gated: post.");
    const second = await setGates(
      db(),
      { reply: [{ signal: "posts", at_least: 4343 }] },
      "Second.",
    );
    expect(second.message).toContain("Gated: reply.");
    expect((await rulesInForce(db())).version).toBe(2);
    const log = await db()<
      { action: string; detail: Record<string, unknown> }[]
    >`
      SELECT action, detail FROM action_log WHERE action = 'admin.gates.set' ORDER BY id`;
    expect(log.map((e) => e.detail.gated)).toEqual(["post", "reply"]);
    expect(log.map((e) => e.detail.version)).toEqual([1, 2]);
    expect(JSON.stringify(log)).not.toMatch(/4242|4343|age_hours|posts"/);
    const history = await gateHistory(db());
    expect(history.map((v) => v.id)).toEqual([2, 1]);
    expect(history[1]?.rules).toEqual({
      post: [{ signal: "age_hours", at_least: 4242 }],
      vote: [],
    });
  });

  it("changes nothing when the file matches the rules in force", async () => {
    await setGates(db(), { post: [{ signal: "claimed", is: true }] }, "Once.");
    const again = await setGates(
      db(),
      { post: [{ signal: "claimed", is: true }] },
      "Twice.",
    );
    expect(again.changed).toBe(false);
    expect((await gateHistory(db())).length).toBe(1);
  });

  it("goes back to an older version by saving it again", async () => {
    await setGates(db(), { post: [{ signal: "claimed", is: true }] }, "One.");
    await setGates(db(), {}, "Open again.");
    const back = await revertGates(db(), 1, "Back to one.");
    expect(back.changed).toBe(true);
    const [logged] = await db()<{ detail: Record<string, unknown> }[]>`
      SELECT detail FROM action_log WHERE action = 'admin.gates.set' ORDER BY id DESC LIMIT 1`;
    expect(logged?.detail).toMatchObject({ version: 3, reverted_from: 1 });
    expect((await rulesInForce(db())).rules).toEqual({
      post: [{ signal: "claimed", is: true }],
    });
    expect((await gateHistory(db())).map((v) => v.id)).toEqual([3, 2, 1]);
    await expect(revertGates(db(), 99, "Nope.")).rejects.toMatchObject({
      code: "no_such_version",
    });
  });

  it("refuses a bad file or no reason, naming where it's wrong and never echoing its values", async () => {
    const attempt = async (values: unknown, reason = "x") => {
      try {
        await setGates(db(), values, reason);
        return "saved";
      } catch (e) {
        return (e as Error).message;
      }
    };
    const unknown = await attempt({ sneaky_9191: [] });
    expect(unknown).toContain("unknown action or field sneaky_9191");
    const wrong = await attempt({
      post: [{ signal: "age_hours", at_least: 5151, at_most: 1 }],
    });
    expect(wrong).toMatch(/post\.0/);
    expect(wrong).not.toContain("5151");
    expect(await attempt({ post: [] }, "")).toMatch(/reason/);
    expect(await gateHistory(db())).toEqual([]);
  });

  it("keeps every version: the table refuses changes and deletes", async () => {
    await setGates(db(), { post: [{ signal: "claimed", is: true }] }, "One.");
    await expect(db()`UPDATE gate_rules SET reason = 'edited'`).rejects.toThrow(
      /append-only/,
    );
    await expect(db()`DELETE FROM gate_rules`).rejects.toThrow(/append-only/);
  });
});

describe("the admin lookup", () => {
  it("shows a bot's signals and which gates it clears", async () => {
    await register("alice");
    await setGates(
      db(),
      { post: [{ signal: "claimed", is: true }] },
      "Claimed only.",
    );
    const look = await lookupBot(db(), "alice");
    expect(look?.signals).toMatchObject({ claimed: false, is_new: true });
    expect(Object.keys(look?.signals ?? {})).toEqual(SIGNAL_NAMES);
    expect(look?.gate_version).toBe(1);
    expect(look?.gates.find((g) => g.action === "post")).toEqual({
      action: "post",
      gated: true,
      open: false,
    });
  });
});

describe("what bots are told", () => {
  const read = (f: string) =>
    readFileSync(path.join(process.cwd(), "content", f), "utf8");

  it("names not_yet in the guide and the connector, and no signal behind it", () => {
    for (const f of ["skill.md", "mcp.md"]) {
      const text = read(f);
      expect(text, f).toContain("not_yet");
      for (const name of SIGNAL_NAMES.filter(
        (n) => n.includes("_") && n !== "is_new",
      ))
        expect(text, `${f} names ${name}`).not.toContain(name);
      expect(text, f).not.toContain("organic");
    }
  });
});
