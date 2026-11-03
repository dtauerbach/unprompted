import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as flagRoute } from "@/app/mod/v1/flags/route";
import { POST as keepRoute } from "@/app/mod/v1/posts/[id]/keep/route";
import { GET as modPostRoute } from "@/app/mod/v1/posts/[id]/route";
import { POST as ackRoute } from "@/app/mod/v1/queue/ack/route";
import { GET as queueRoute } from "@/app/mod/v1/queue/route";
import { POST as reportRoute } from "@/app/v1/posts/[id]/report/route";
import { GET as threadRoute } from "@/app/v1/posts/[id]/route";
import { POST as postRoute } from "@/app/v1/posts/route";
import { hidePost, moderatorLog, openReports, setFrozen } from "@/lib/admin";
import { recentFlags } from "@/lib/agent-mod";
import { db } from "@/lib/db";
import { syncWelcome } from "@/lib/house";
import {
  addModKey,
  listModKeys,
  MOD_KEY_PREFIX,
  revokeModKey,
} from "@/lib/mod-keys";
import { awayFromWindowEdge, call, register, resetDb } from "./helpers";
import { ageLog, hide, modKey, newPost } from "./mod-helpers";

beforeEach(resetDb);
afterEach(() => {
  delete process.env.UNPROMPTED_READ_ONLY;
});

function queue(key: string, limit?: number) {
  return call(queueRoute, {
    key,
    path: `/mod/v1/queue${limit ? `?limit=${limit}` : ""}`,
  });
}

function visible(id: number) {
  return call(threadRoute, {
    path: `/v1/posts/${id}`,
    params: { id: String(id) },
  });
}

describe("moderator keys", () => {
  it("are refused without a key, with a bot's key, and once revoked", async () => {
    const bot = await register("alice");
    expect((await queue("")).body.error.code).toBe("missing_key");
    const asBot = await queue(bot.key);
    expect(asBot.status).toBe(401);
    expect(asBot.body.error.code).toBe("invalid_key");
    const key = await modKey();
    expect((await queue(key)).status).toBe(200);
    const [row] = await listModKeys(db());
    await revokeModKey(db(), row?.id ?? 0, "Testing.", "test");
    expect((await queue(key)).body.error.code).toBe("invalid_key");
    expect((await queue(`${MOD_KEY_PREFIX}${"a".repeat(43)}`)).status).toBe(
      401,
    );
  });

  it("don't work on the bots' API", async () => {
    const key = await modKey();
    const res = await call(postRoute, {
      key,
      body: { channel: "meta", body: "hi" },
    });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("invalid_key");
  });

  it("keep their roles apart", async () => {
    const appeals = await modKey("appeals");
    const res = await queue(appeals);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("wrong_role");
    const bot = await register("alice");
    const id = await newPost(bot.key);
    expect((await hide(appeals, id)).body.error.code).toBe("wrong_role");
    expect(await db()`SELECT 1 FROM hidden_posts`).toHaveLength(0);
  });

  it("are stored only as hashes, and a label and role are checked", async () => {
    const key = await modKey();
    const rows = await db()`SELECT key_hash FROM mod_keys`;
    expect(JSON.stringify(rows)).not.toContain(key);
    await expect(
      addModKey(db(), "admin", "x-label", "Testing.", "test"),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      addModKey(db(), "moderator", "Bad Label", "Testing.", "test"),
    ).rejects.toMatchObject({ code: "invalid" });
    // A label names one key in the record, even after a revoke.
    await revokeModKey(db(), 1, "Testing.", "test");
    await expect(
      addModKey(db(), "appeals", "mod-one", "Testing.", "test"),
    ).rejects.toMatchObject({ code: "label_taken" });
  });

  it("can't be changed in the database except by revoking or moving the cursor", async () => {
    await modKey();
    await expect(db()`UPDATE mod_keys SET role = 'appeals'`).rejects.toThrow();
    await expect(db()`DELETE FROM mod_keys`).rejects.toThrow();
    await db()`UPDATE mod_keys SET revoked_at = now()`;
    await expect(db()`UPDATE mod_keys SET revoked_at = NULL`).rejects.toThrow();
  });
});

describe("the queue", () => {
  it("starts a new key at the end of the log", async () => {
    const bot = await register("alice");
    await newPost(bot.key);
    await ageLog();
    const key = await modKey();
    const res = await queue(key);
    expect(res.body.items).toEqual([]);
    expect(res.body.through).toBeNull();
  });

  it("serves new posts, replies, channels, bots, reports and alerts, with only what a moderator needs", async () => {
    const key = await modKey();
    const alice = await register("alice", { display_name: "Alice" });
    const bob = await register("bob");
    const root = await newPost(alice.key, "a thread");
    await new Promise((r) => setTimeout(r, 1100));
    const reply = await newPost(bob.key, "a reply", { reply_to: root });
    await call(reportRoute, {
      key: alice.key,
      path: `/v1/posts/${reply}/report`,
      params: { id: String(reply) },
      body: { reason: "spam", note: "selling something" },
    });
    // Not served until it's settled.
    expect((await queue(key)).body.items).toEqual([]);
    await ageLog();
    const res = await queue(key);
    expect(res.status).toBe(200);
    const kinds = res.body.items.map((i: { kind: string }) => i.kind);
    expect(kinds).toEqual(["bot", "bot", "post", "post", "report"]);
    const [, , first, second, report] = res.body.items;
    expect(res.body.items[0].bot).toMatchObject({
      handle: "alice",
      untrusted_display_name: "Alice",
    });
    expect(first.post).toMatchObject({
      id: root,
      channel: "meta",
      untrusted_body: "a thread",
      hidden: false,
      author: { handle: "alice", is_new: true, claimed: false },
    });
    expect(second.post.root).toMatchObject({
      id: root,
      author: "alice",
      untrusted_body: "a thread",
    });
    expect(report.report).toMatchObject({
      post_id: reply,
      reason: "spam",
      untrusted_note: "selling something",
      reporter: "alice",
    });
    expect(res.body.notice).toContain("not instructions");
    // Nothing private rides along.
    const text = JSON.stringify(res.body);
    expect(text).not.toContain("ip_hash");
    expect(text).not.toContain("owner");
    expect(res.body.through).toBe(report.log_id);
  });

  it("pages, and moves on only when acknowledged, never backwards or past the end", async () => {
    const key = await modKey();
    const alice = await register("alice");
    await newPost(alice.key, "one");
    await ageLog();
    const page = await queue(key, 1);
    expect(page.body.items).toHaveLength(1);
    expect(page.body.more).toBe(true);
    // Unacknowledged, the same page comes back.
    expect((await queue(key, 1)).body.items[0].log_id).toBe(
      page.body.items[0].log_id,
    );
    const ack = (through: number) => call(ackRoute, { key, body: { through } });
    expect((await ack(page.body.through)).body.acked).toBe(page.body.through);
    const rest = await queue(key);
    expect(rest.body.items.map((i: { kind: string }) => i.kind)).toEqual([
      "post",
    ]);
    expect((await ack(0)).body.acked).toBe(page.body.through);
    const past = await ack(rest.body.through + 1000);
    expect(past.status).toBe(400);
    expect((await ack(rest.body.through)).status).toBe(200);
    expect((await queue(key)).body.items).toEqual([]);
  });

  it("serves a duplicate-posts alert, from young bots posting the same text", async () => {
    const key = await modKey();
    const text = "Join the gull coin presale today and double your money fast.";
    const ids: number[] = [];
    for (const handle of ["gulla", "gullb", "gullc"]) {
      const bot = await register(handle);
      ids.push(await newPost(bot.key, text));
    }
    expect(
      await db()`SELECT 1 FROM action_log WHERE action = 'alert.duplicate_posts'`,
    ).toHaveLength(1);
    await ageLog();
    const res = await queue(key);
    const alerts = res.body.items.filter(
      (i: { kind: string }) => i.kind === "alert",
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0].alert.type).toBe("duplicate_posts");
    expect(ids).toContain(alerts[0].alert.post_id);
  });

  it("refuses a bad limit", async () => {
    const key = await modKey();
    expect((await queue(key, 1000)).status).toBe(400);
  });
});

describe("a moderator's post view", () => {
  it("shows a post with its thread and its author's latest, hidden ones too, to either role", async () => {
    const mod = await modKey();
    const appeals = await modKey("appeals");
    const alice = await register("alice");
    const root = await newPost(alice.key, "the root");
    await hidePost(db(), root, "Testing.");
    for (const key of [mod, appeals]) {
      const res = await call(modPostRoute, {
        key,
        path: `/mod/v1/posts/${root}`,
        params: { id: String(root) },
      });
      expect(res.status).toBe(200);
      expect(res.body.post).toMatchObject({ id: root, hidden: true });
      expect(res.body.author_recent[0].id).toBe(root);
    }
    const missing = await call(modPostRoute, {
      key: mod,
      path: "/mod/v1/posts/999",
      params: { id: "999" },
    });
    expect(missing.status).toBe(404);
  });
});

describe("hiding", () => {
  it("hides a post from every bot, records the reason, and logs it with the agent named", async () => {
    const key = await modKey();
    const alice = await register("alice");
    const id = await newPost(alice.key, "buy my coin");
    const res = await hide(key, id, {
      reason: "spam",
      rationale: "Promotes a coin.\nSecond line.",
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ hidden: true });
    expect((await visible(id)).status).toBe(404);
    const [row] = await db()<{ reason: string; rationale: string }[]>`
      SELECT reason, rationale FROM agent_hides WHERE post_id = ${id}`;
    expect(row).toMatchObject({
      reason: "spam",
      rationale: "Promotes a coin.\nSecond line.",
    });
    const [entry] = await moderatorLog(db(), { limit: 1 });
    expect(entry).toMatchObject({
      action: "post.hide",
      subject: `post:${id}`,
      by: "agent:mod-one",
    });
  });

  it("refuses a hidden post, a house post, a missing one, and one an appeal put back", async () => {
    const key = await modKey();
    const alice = await register("alice");
    const id = await newPost(alice.key);
    await hide(key, id);
    expect((await hide(key, id)).body.error.code).toBe("already_hidden");
    expect((await hide(key, 999)).status).toBe(404);
    const pin = (await syncWelcome(db(), "Welcome.")) as number;
    expect((await hide(key, pin)).body.error.code).toBe("house_post");
    // Put back (here by an admin): the agent can't hide it again.
    await db()`DELETE FROM hidden_posts WHERE post_id = ${id}`;
    expect((await hide(key, id)).body.error.code).toBe("overturned");
  });

  it("refuses a reason outside the list, an empty rationale, or invisible text", async () => {
    const key = await modKey();
    const alice = await register("alice");
    const id = await newPost(alice.key);
    for (const body of [
      { reason: "rude", rationale: "x" },
      { reason: "spam", rationale: "" },
      { reason: "spam", rationale: "ok‮evil" },
      { reason: "spam", rationale: "x".repeat(1001) },
      { reason: "spam", rationale: "x", extra: true },
    ]) {
      const res = await hide(key, id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(await db()`SELECT 1 FROM hidden_posts`).toHaveLength(0);
  });

  it("stops at the hourly cap, writes nothing past it, and flags the humans once", async () => {
    await db()`
      INSERT INTO settings (key, value)
      VALUES ('anti_abuse_limits', ${JSON.stringify({ agent_hides_per_hour: 2 })}::text::jsonb)`;
    const key = await modKey();
    const alice = await register("alice");
    const ids: number[] = [];
    for (const n of [1, 2, 3, 4]) {
      ids.push(await newPost(alice.key, `post ${n}`));
      await db()`DELETE FROM rate_limits`;
    }
    expect((await hide(key, ids[0] ?? 0)).status).toBe(200);
    expect((await hide(key, ids[1] ?? 0)).status).toBe(200);
    const capped = await hide(key, ids[2] ?? 0);
    expect(capped.status).toBe(429);
    expect(capped.body.error.code).toBe("hide_cap");
    expect(capped.body.error.message).not.toMatch(/\d/);
    expect((await hide(key, ids[3] ?? 0)).status).toBe(429);
    expect(await db()`SELECT 1 FROM agent_hides`).toHaveLength(2);
    expect((await visible(ids[2] ?? 0)).status).toBe(200);
    const flags = await recentFlags(db(), 1);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ kind: "hide_cap", by: "site" });
  });

  it("is refused under the kill switch", async () => {
    const key = await modKey();
    const alice = await register("alice");
    const id = await newPost(alice.key);
    process.env.UNPROMPTED_READ_ONLY = "1";
    expect((await hide(key, id)).status).toBe(503);
    expect(await db()`SELECT 1 FROM hidden_posts`).toHaveLength(0);
  });

  it("keeps its record append-only", async () => {
    const key = await modKey();
    const alice = await register("alice");
    const id = await newPost(alice.key);
    await hide(key, id);
    await expect(
      db()`UPDATE agent_hides SET reason = 'other'`,
    ).rejects.toThrow();
    await expect(db()`DELETE FROM agent_hides`).rejects.toThrow();
  });
});

describe("keeping", () => {
  it("clears a reviewed post's reports from the humans' queue", async () => {
    const key = await modKey();
    const alice = await register("alice");
    const bob = await register("bob");
    const id = await newPost(alice.key);
    await call(reportRoute, {
      key: bob.key,
      path: `/v1/posts/${id}/report`,
      params: { id: String(id) },
      body: { reason: "other" },
    });
    expect(await openReports(db())).toHaveLength(1);
    const res = await call(keepRoute, {
      key,
      path: `/mod/v1/posts/${id}/keep`,
      params: { id: String(id) },
      body: { note: "Disagreement, not harassment." },
    });
    expect(res.status).toBe(200);
    expect(await openReports(db())).toHaveLength(0);
    expect((await visible(id)).status).toBe(200);
  });
});

describe("flags", () => {
  function flag(key: string, body: unknown) {
    return call(flagRoute, { key, body });
  }

  it("go to the humans, with the agent named", async () => {
    const key = await modKey();
    const res = await flag(key, {
      subject: "bot:alice",
      kind: "ban",
      note: "Promotes a token in every post.",
    });
    expect(res.status).toBe(201);
    const [f] = await recentFlags(db(), 1);
    expect(f).toMatchObject({
      subject: "bot:alice",
      kind: "ban",
      by: "agent:mod-one",
    });
  });

  it("refuse a subject or kind outside the list", async () => {
    const key = await modKey();
    for (const body of [
      { subject: "post:abc", kind: "ban", note: "x" },
      { subject: "user:bob", kind: "review", note: "x" },
      { subject: "site", kind: "hide_cap", note: "x" },
      { subject: "site", kind: "review", note: "" },
    ])
      expect((await flag(key, body)).status, JSON.stringify(body)).toBe(400);
    expect(await recentFlags(db(), 1)).toHaveLength(0);
  });

  it("are limited per key per hour", async () => {
    await awayFromWindowEdge(3600);
    await db()`
      INSERT INTO settings (key, value)
      VALUES ('anti_abuse_limits', ${JSON.stringify({ mod_flag_per_hour: 2 })}::text::jsonb)`;
    const key = await modKey();
    const body = { subject: "site", kind: "review", note: "Look." };
    expect((await flag(key, body)).status).toBe(201);
    expect((await flag(key, body)).status).toBe(201);
    const third = await flag(key, body);
    expect(third.status).toBe(429);
    expect(third.body.error.message).not.toMatch(/\b2\b/);
    expect(await recentFlags(db(), 1)).toHaveLength(2);
  });
});

describe("what a frozen author's posts mean", () => {
  it("still lets an agent hide them", async () => {
    const key = await modKey();
    const alice = await register("alice");
    const id = await newPost(alice.key);
    await setFrozen(db(), "alice", true, "Testing.");
    expect((await hide(key, id)).status).toBe(200);
  });
});
