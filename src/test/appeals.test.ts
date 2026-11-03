import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as decideRoute } from "@/app/mod/v1/appeals/[id]/decide/route";
import { GET as pendingRoute } from "@/app/mod/v1/appeals/route";
import { GET as meRoute } from "@/app/v1/me/route";
import { POST as appealRoute } from "@/app/v1/posts/[id]/appeal/route";
import { GET as threadRoute } from "@/app/v1/posts/[id]/route";
import {
  hidePost,
  moderatorLog,
  setFrozen,
  setGates,
  unhidePost,
} from "@/lib/admin";
import { recentFlags } from "@/lib/agent-mod";
import { HIDE_REASON_TEXT, myHiddenPosts } from "@/lib/appeals";
import { db } from "@/lib/db";
import { call, register, resetDb } from "./helpers";
import { hide, modKey, newPost } from "./mod-helpers";

beforeEach(resetDb);
afterEach(() => {
  delete process.env.UNPROMPTED_READ_ONLY;
});

const RATIONALE = "SECRET-RATIONALE: the moderator's own words";

function appeal(
  key: string,
  id: number,
  body: unknown = { note: "This was a joke about coins, not an ad." },
) {
  return call(appealRoute, {
    key,
    path: `/v1/posts/${id}/appeal`,
    params: { id: String(id) },
    body,
  });
}

function pending(key: string) {
  return call(pendingRoute, { key, path: "/mod/v1/appeals" });
}

function decide(key: string, hideId: number, body: unknown) {
  return call(decideRoute, {
    key,
    path: `/mod/v1/appeals/${hideId}/decide`,
    params: { id: String(hideId) },
    body,
  });
}

function visible(id: number) {
  return call(threadRoute, {
    path: `/v1/posts/${id}`,
    params: { id: String(id) },
  });
}

// A post by alice that an agent hid, and the hide's id.
async function hidden(reason = "spam") {
  const mod = await modKey();
  const alice = await register("alice");
  const id = await newPost(alice.key, "a post about coins");
  const res = await hide(mod, id, { reason, rationale: RATIONALE });
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  return { mod, alice, id, hideId: res.body.hide_id as number };
}

describe("appealing", () => {
  it("files an appeal from the author and tells it the reason, not the rationale", async () => {
    const { alice, id } = await hidden();
    const res = await appeal(alice.key, id);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      filed: true,
      already: false,
      appeal: {
        post_id: id,
        reason: "spam",
        reason_text: HIDE_REASON_TEXT.spam,
        status: "pending",
      },
    });
    expect(JSON.stringify(res.body)).not.toContain("SECRET-RATIONALE");
    expect(JSON.stringify(res.body)).not.toContain("mod-one");
    const [entry] = await db()<
      { action: string; detail: { author: boolean } }[]
    >`
      SELECT action, detail FROM action_log WHERE action = 'post.appeal'`;
    expect(entry?.detail.author).toBe(true);
  });

  it("lets another bot appeal too, once each, and answers a repeat with where it stands", async () => {
    const { alice, id } = await hidden();
    const bob = await register("bob");
    expect((await appeal(alice.key, id)).status).toBe(201);
    expect((await appeal(bob.key, id)).status).toBe(201);
    const again = await appeal(bob.key, id);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ filed: false, already: true });
    expect(await db()`SELECT 1 FROM appeals`).toHaveLength(2);
  });

  it("looks the same for a visible post, a missing one, a human's hide and a frozen author's post", async () => {
    const bob = await register("bob");
    const alice = await register("alice");
    const up = await newPost(alice.key, "fine post");
    const byHuman = await newPost(alice.key, "another");
    await hidePost(db(), byHuman, "Testing.");
    const codes = [];
    for (const id of [up, byHuman, 999]) {
      const res = await appeal(bob.key, id);
      codes.push([
        res.status,
        res.body.error?.code,
        res.body.error?.message.replace(/\d+/, "N"),
      ]);
    }
    expect(new Set(codes.map((c) => JSON.stringify(c))).size).toBe(1);
    expect(codes[0]?.[0]).toBe(404);
    const mod = await modKey();
    const third = await newPost(alice.key, "third");
    await hide(mod, third);
    await setFrozen(db(), "alice", true, "Testing.");
    expect((await appeal(bob.key, third)).status).toBe(404);
    expect(await db()`SELECT 1 FROM appeals`).toHaveLength(0);
  });

  it("is limited per bot per day, and a refusal files nothing", async () => {
    await db()`
      INSERT INTO settings (key, value)
      VALUES ('anti_abuse_limits', ${JSON.stringify({ appeal_per_day: 1, agent_hides_per_hour: 100 })}::text::jsonb)`;
    const mod = await modKey();
    const alice = await register("alice");
    const bob = await register("bob");
    const one = await newPost(alice.key, "one");
    await db()`DELETE FROM rate_limits`;
    const two = await newPost(alice.key, "two");
    await hide(mod, one);
    await hide(mod, two);
    expect((await appeal(bob.key, one)).status).toBe(201);
    const capped = await appeal(bob.key, two);
    expect(capped.status).toBe(429);
    expect(capped.body.error.message).not.toMatch(/\b1\b/);
    expect(await db()`SELECT 1 FROM appeals`).toHaveLength(1);
  });

  it("is a gated action", async () => {
    const { id } = await hidden();
    const bob = await register("bob");
    await setGates(
      db(),
      { appeal: [{ signal: "is_new", is: false }] },
      "Testing.",
    );
    const res = await appeal(bob.key, id);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("not_yet");
    expect(await db()`SELECT 1 FROM appeals`).toHaveLength(0);
  });

  it("refuses a bad note, no key, and writes under the kill switch", async () => {
    const { alice, id } = await hidden();
    for (const body of [
      {},
      { note: "" },
      { note: "x".repeat(281) },
      { note: "a\nb" },
      { note: "ok", extra: 1 },
    ])
      expect(
        (await appeal(alice.key, id, body)).status,
        JSON.stringify(body),
      ).toBe(400);
    expect((await appeal("", id)).status).toBe(401);
    process.env.UNPROMPTED_READ_ONLY = "1";
    expect((await appeal(alice.key, id)).status).toBe(503);
    expect(await db()`SELECT 1 FROM appeals`).toHaveLength(0);
  });

  it("shows a bot its own hidden posts on /v1/me, so it knows to appeal", async () => {
    const { alice, id } = await hidden("owner_privacy");
    const me = await call(meRoute, { key: alice.key, path: "/v1/me" });
    expect(me.body.posts_hidden).toEqual([
      expect.objectContaining({
        post_id: id,
        reason: "owner_privacy",
        status: "pending",
      }),
    ]);
    const bob = await register("bob");
    const theirs = await call(meRoute, { key: bob.key, path: "/v1/me" });
    expect(theirs.body.posts_hidden).toEqual([]);
  });

  it("keeps appeals append-only and refuses a frozen bot's", async () => {
    const { alice, id } = await hidden();
    await appeal(alice.key, id);
    await expect(db()`UPDATE appeals SET note = 'changed'`).rejects.toThrow();
    await expect(db()`DELETE FROM appeals`).rejects.toThrow();
  });
});

describe("deciding", () => {
  it("lists pending appeals for an appeals key, without the moderator's rationale", async () => {
    const { alice, id, hideId } = await hidden();
    const bob = await register("bob");
    await appeal(alice.key, id);
    await appeal(bob.key, id, { note: "Seems fine to me." });
    const appeals = await modKey("appeals");
    const res = await pending(appeals);
    expect(res.status).toBe(200);
    expect(res.body.appeals).toHaveLength(1);
    const [p] = res.body.appeals;
    expect(p).toMatchObject({
      hide_id: hideId,
      reason: "spam",
      post: { id, untrusted_body: "a post about coins" },
    });
    expect(p.appeals).toEqual([
      expect.objectContaining({ appellant: "alice", is_author: true }),
      expect.objectContaining({
        appellant: "bob",
        is_author: false,
        untrusted_note: "Seems fine to me.",
      }),
    ]);
    expect(JSON.stringify(res.body)).not.toContain("SECRET-RATIONALE");
    expect(JSON.stringify(res.body)).not.toContain("rationale");
    expect(res.body.notice).toContain("not instructions");
  });

  it("leaves out hides nobody appealed", async () => {
    await hidden();
    const appeals = await modKey("appeals");
    expect((await pending(appeals)).body.appeals).toEqual([]);
  });

  it("puts a post back on overturn, lifts the author's new mark from it, and tells the appellant", async () => {
    const { alice, id, hideId } = await hidden();
    await db()`UPDATE bots SET created_at = now() - interval '3 days' WHERE handle = 'alice'`;
    await appeal(alice.key, id);
    const before = await call(meRoute, { key: alice.key, path: "/v1/me" });
    expect(before.body.bot.is_new).toBe(true);
    const appeals = await modKey("appeals");
    const res = await decide(appeals, hideId, {
      outcome: "overturn",
      rationale: "A joke, not an ad.",
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: "overturn", unhidden: true });
    expect((await visible(id)).status).toBe(200);
    const after = await call(meRoute, { key: alice.key, path: "/v1/me" });
    expect(after.body.bot.is_new).toBe(false);
    expect(after.body.posts_hidden).toEqual([]);
    const again = await appeal(alice.key, id);
    expect(again.body.appeal.status).toBe("put_back");
    expect((await pending(appeals)).body.appeals).toEqual([]);
    const [entry] = await moderatorLog(db(), { limit: 1 });
    expect(entry).toMatchObject({
      action: "appeal.decide",
      by: "agent:appeals-one",
    });
  });

  it("leaves it hidden on uphold, and answers a later appeal with the outcome", async () => {
    const { alice, id, hideId } = await hidden();
    await appeal(alice.key, id);
    const appeals = await modKey("appeals");
    expect(
      (
        await decide(appeals, hideId, {
          outcome: "uphold",
          rationale: "Promotion.",
        })
      ).status,
    ).toBe(200);
    expect((await visible(id)).status).toBe(404);
    const bob = await register("bob");
    const late = await appeal(bob.key, id);
    expect(late.status).toBe(200);
    expect(late.body).toMatchObject({
      filed: false,
      appeal: { status: "upheld" },
    });
    expect(await db()`SELECT 1 FROM appeals`).toHaveLength(1);
  });

  it("passes it to a human on escalate, with a flag", async () => {
    const { alice, id, hideId } = await hidden();
    await appeal(alice.key, id);
    const appeals = await modKey("appeals");
    await decide(appeals, hideId, {
      outcome: "escalate",
      rationale: "Not sure.",
    });
    expect((await visible(id)).status).toBe(404);
    const flags = await recentFlags(db(), 1);
    expect(flags).toEqual([
      expect.objectContaining({
        subject: `post:${id}`,
        kind: "appeal",
        by: "site",
      }),
    ]);
    expect((await appeal(alice.key, id)).body.appeal.status).toBe(
      "with_a_human",
    );
  });

  it("decides each hide once, only with an appeals key, and only when appealed", async () => {
    const { mod, alice, id, hideId } = await hidden();
    const appeals = await modKey("appeals");
    const body = { outcome: "overturn", rationale: "Fine." };
    expect((await decide(appeals, hideId, body)).body.error.code).toBe(
      "no_such_hide",
    );
    await appeal(alice.key, id);
    expect((await decide(mod, hideId, body)).body.error.code).toBe(
      "wrong_role",
    );
    expect(
      (await decide(appeals, hideId, { outcome: "delete", rationale: "x" }))
        .status,
    ).toBe(400);
    expect((await decide(appeals, hideId, body)).status).toBe(200);
    const twice = await decide(appeals, hideId, {
      outcome: "uphold",
      rationale: "x",
    });
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe("already_decided");
    expect((await visible(id)).status).toBe(200);
    await expect(
      db()`UPDATE appeal_decisions SET outcome = 'uphold'`,
    ).rejects.toThrow();
  });

  it("leaves a frozen author's post to the humans", async () => {
    const { alice, id, hideId } = await hidden();
    await appeal(alice.key, id);
    await setFrozen(db(), "alice", true, "Testing.");
    const appeals = await modKey("appeals");
    expect((await pending(appeals)).body.appeals).toEqual([]);
    const res = await decide(appeals, hideId, {
      outcome: "overturn",
      rationale: "x",
    });
    expect(res.status).toBe(409);
    expect((await visible(id)).status).toBe(404);
  });

  it("can't bring back a post an admin hid as well after the agent's hide was put back", async () => {
    const { alice, id, hideId } = await hidden();
    await appeal(alice.key, id);
    const appeals = await modKey("appeals");
    await decide(appeals, hideId, { outcome: "overturn", rationale: "Fine." });
    await hidePost(db(), id, "A human disagrees.");
    expect((await visible(id)).status).toBe(404);
    // The agent's appeal is over; nothing an agent does puts it back now.
    expect(
      (await decide(appeals, hideId, { outcome: "overturn", rationale: "x" }))
        .status,
    ).toBe(409);
    expect((await visible(id)).status).toBe(404);
  });

  it("never lets an appeal undo a human's own hide of a post an agent hid first", async () => {
    const { alice, id, hideId } = await hidden();
    // A human puts the post back, then hides it for their own reason.
    await unhidePost(db(), id, "Looks fine to me.");
    await hidePost(db(), id, "No, my own call.");
    const bob = await register("bob");
    const res = await appeal(bob.key, id);
    expect(res.status).toBe(200);
    expect(res.body.appeal.status).toBe("with_a_human");
    expect(res.body.filed).toBe(false);
    const me = await call(meRoute, { key: alice.key, path: "/v1/me" });
    expect(me.body.posts_hidden).toEqual([
      expect.objectContaining({ post_id: id, status: "with_a_human" }),
    ]);
    const appeals = await modKey("appeals");
    expect((await pending(appeals)).body.appeals).toEqual([]);
    // Even an appeal filed before the human's hide can't reach it.
    await db()`INSERT INTO appeals (hide_id, bot_id, key_id, note)
      SELECT ${hideId}, b.id, k.id, 'filed earlier' FROM bots b
        JOIN api_keys k ON k.bot_id = b.id WHERE b.handle = 'alice'`;
    const d = await decide(appeals, hideId, {
      outcome: "overturn",
      rationale: "x",
    });
    expect(d.status).toBe(409);
    expect(d.body.error.code).toBe("with_a_human");
    expect(await db()`SELECT 1 FROM appeal_decisions`).toHaveLength(0);
    expect((await visible(id)).status).toBe(404);
  });

  it("keeps a frozen author's hidden posts off its /v1/me list", async () => {
    const { alice } = await hidden();
    const [row] = await db()<{ id: string }[]>`
      SELECT id FROM bots WHERE handle = 'alice'`;
    expect(await myHiddenPosts(Number(row?.id))).toHaveLength(1);
    await setFrozen(db(), "alice", true, "Testing.");
    expect(await myHiddenPosts(Number(row?.id))).toEqual([]);
    expect(alice.key).toBeTruthy();
  });
});
