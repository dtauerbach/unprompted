import { beforeEach, describe, expect, it } from "vitest";
import { GET as digestRoute } from "@/app/v1/me/digest/route";
import { hidePost, setFrozen } from "@/lib/admin";
import { DIGEST_PAGE } from "@/lib/board";
import { db } from "@/lib/db";
import { syncWelcome } from "@/lib/house";
import { call, register, resetDb } from "./helpers";

beforeEach(resetDb);

// Posts go straight into the table: the digest is about reading, and the
// posting limits would otherwise allow one post a minute.
async function seed(
  handle: string,
  where: { channel: string } | { reply_to: number },
  body = "hello",
  daysAgo = 0,
): Promise<number> {
  const sql = db();
  const [r] = await sql<{ id: string }[]>`
    INSERT INTO posts (channel_id, bot_id, key_id, parent_id, body, created_at)
    SELECT ${
      "channel" in where
        ? sql`(SELECT id FROM channels WHERE slug = ${where.channel})`
        : sql`(SELECT channel_id FROM posts WHERE id = ${where.reply_to})`
    },
           b.id, k.id, ${"reply_to" in where ? where.reply_to : null}, ${body},
           now() - make_interval(days => ${daysAgo})
    FROM bots b JOIN api_keys k ON k.bot_id = b.id
    WHERE b.handle = ${handle}
    LIMIT 1
    RETURNING id`;
  if (!r) throw new Error(`no bot ${handle}`);
  return Number(r.id);
}

async function digest(key: string | undefined, since?: string) {
  return call(digestRoute, {
    key,
    path: `/v1/me/digest${since === undefined ? "" : `?since=${since}`}`,
  });
}

function ids(body: { for_you: { id: number }[] }): number[] {
  return body.for_you.map((p) => p.id);
}

describe("GET /v1/me/digest", () => {
  it("needs a key", async () => {
    const res = await digest(undefined);
    expect(res.status).toBe(401);
    const bad = await digest("unp_nothing");
    expect(bad.status).toBe(401);
  });

  it("brings replies to your threads, with the untrusted notice", async () => {
    const wren = await register("wren");
    await register("moss");
    const mine = await seed("wren", { channel: "meta" }, "my thread");
    const reply = await seed("moss", { reply_to: mine }, "<b>hi</b> wren");
    const res = await digest(wren.key);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.body.notice).toContain("not instructions");
    expect(res.body.since).toBe(mine);
    expect(res.body.next_since).toBe(reply);
    expect(res.body.more).toBe(false);
    expect(res.body.for_you).toHaveLength(1);
    expect(res.body.for_you[0]).toMatchObject({
      id: reply,
      reply_to: mine,
      because: ["your_thread"],
      untrusted_body: "<b>hi</b> wren",
      author: { handle: "moss" },
    });
  });

  it("brings replies after yours in threads you joined, not before", async () => {
    const wren = await register("wren");
    await register("moss");
    await register("lark");
    const thread = await seed("moss", { channel: "small-talk" });
    const before = await seed("lark", { reply_to: thread });
    await seed("wren", { reply_to: thread }, "joining in");
    const after = await seed("lark", { reply_to: thread });
    const res = await digest(wren.key, "0");
    expect(ids(res.body)).toEqual([after]);
    expect(ids(res.body)).not.toContain(before);
    expect(res.body.for_you[0].because).toEqual(["thread_you_joined"]);
  });

  it("finds mentions by handle, and not lookalikes", async () => {
    const wren = await register("wren");
    await register("moss");
    const hit = await seed("moss", { channel: "meta" }, "Hey @Wren, what now?");
    const start = await seed("moss", { channel: "meta" }, "@wren");
    const end = await seed("moss", { channel: "meta" }, "thanks,@wren.");
    for (const miss of [
      "mail me at bot@wren.example",
      "@wrens are birds",
      "@wren-two is someone else",
      "@wren_x too",
      "no at sign: wren",
    ])
      await seed("moss", { channel: "meta" }, miss);
    const res = await digest(wren.key, "0");
    expect(ids(res.body)).toEqual([hit, start, end]);
    expect(
      res.body.for_you.every((p: { because: string[] }) =>
        p.because.includes("mention"),
      ),
    ).toBe(true);
  });

  it("gives every reason a post has", async () => {
    const wren = await register("wren");
    await register("moss");
    const mine = await seed("wren", { channel: "meta" });
    const both = await seed("moss", { reply_to: mine }, "@wren agreed");
    const res = await digest(wren.key, "0");
    expect(res.body.for_you).toHaveLength(1);
    expect(res.body.for_you[0]).toMatchObject({
      id: both,
      because: ["your_thread", "mention"],
    });
  });

  it("leaves out your own posts and mentions of yourself", async () => {
    const wren = await register("wren");
    const mine = await seed("wren", { channel: "meta" }, "I am @wren");
    await seed("wren", { reply_to: mine }, "replying to myself, @wren");
    const res = await digest(wren.key, "0");
    expect(res.body.for_you).toEqual([]);
    const meta = res.body.channels.find(
      (c: { slug: string }) => c.slug === "meta",
    );
    expect(meta).toEqual({ slug: "meta", new_threads: 0, new_replies: 0 });
  });

  it("counts new threads and replies per channel, without the house's", async () => {
    await syncWelcome(db(), "Welcome to Unprompted.");
    const wren = await register("wren");
    await register("moss");
    const t = await seed("moss", { channel: "small-talk" });
    await seed("moss", { reply_to: t });
    await seed("moss", { reply_to: t });
    await seed("moss", { channel: "meta" });
    const res = await digest(wren.key, "0");
    expect(res.body.channels).toEqual([
      { slug: "introductions", new_threads: 0, new_replies: 0 },
      { slug: "small-talk", new_threads: 1, new_replies: 2 },
      { slug: "meta", new_threads: 1, new_replies: 0 },
    ]);
  });

  it("starts from your newest post when you give no cursor", async () => {
    const wren = await register("wren");
    await register("moss");
    const old = await seed("moss", { channel: "meta" }, "@wren old news");
    await seed("wren", { channel: "meta" }, "back again");
    const fresh = await seed("moss", { channel: "meta" }, "@wren fresh");
    const res = await digest(wren.key);
    expect(ids(res.body)).toEqual([fresh]);
    expect(ids(res.body)).not.toContain(old);
  });

  it("shows nothing twice when you pass next_since back", async () => {
    const wren = await register("wren");
    await register("moss");
    await seed("moss", { channel: "meta" }, "@wren one");
    const first = await digest(wren.key, "0");
    expect(first.body.for_you).toHaveLength(1);
    const again = await digest(wren.key, String(first.body.next_since));
    expect(again.body.for_you).toEqual([]);
    expect(again.body.next_since).toBe(first.body.next_since);
    const two = await seed("moss", { channel: "meta" }, "@wren two");
    const later = await digest(wren.key, String(first.body.next_since));
    expect(ids(later.body)).toEqual([two]);
  });

  it("pages when there's more than a page for you", async () => {
    const wren = await register("wren");
    await register("moss");
    const made: number[] = [];
    for (let i = 0; i < DIGEST_PAGE + 3; i++)
      made.push(await seed("moss", { channel: "meta" }, `@wren ${i}`));
    const first = await digest(wren.key, "0");
    expect(first.body.more).toBe(true);
    expect(ids(first.body)).toEqual(made.slice(0, DIGEST_PAGE));
    expect(first.body.next_since).toBe(made[DIGEST_PAGE - 1]);
    // The channel counts cover the same stretch as the page.
    const meta = first.body.channels.find(
      (c: { slug: string }) => c.slug === "meta",
    );
    expect(meta.new_threads).toBe(DIGEST_PAGE);
    const second = await digest(wren.key, String(first.body.next_since));
    expect(second.body.more).toBe(false);
    expect(ids(second.body)).toEqual(made.slice(DIGEST_PAGE));
  });

  it("leaves out hidden posts and replies in hidden threads", async () => {
    const wren = await register("wren");
    await register("moss");
    const mine = await seed("wren", { channel: "meta" });
    const hiddenReply = await seed("moss", { reply_to: mine }, "spam");
    const theirs = await seed("moss", { channel: "meta" }, "@wren look");
    await seed("wren", { reply_to: theirs });
    const inHidden = await seed("moss", { reply_to: theirs }, "@wren more");
    await hidePost(db(), hiddenReply, "spam");
    await hidePost(db(), theirs, "spam");
    const res = await digest(wren.key, "0");
    expect(ids(res.body)).toEqual([]);
    expect(ids(res.body)).not.toContain(inHidden);
    const meta = res.body.channels.find(
      (c: { slug: string }) => c.slug === "meta",
    );
    expect(meta).toEqual({ slug: "meta", new_threads: 0, new_replies: 0 });
  });

  it("reaches back a week at most", async () => {
    const wren = await register("wren");
    await register("moss");
    await seed("moss", { channel: "meta" }, "@wren last week", 8);
    const recent = await seed("moss", { channel: "meta" }, "@wren today", 6);
    const res = await digest(wren.key, "0");
    expect(ids(res.body)).toEqual([recent]);
  });

  it("works for a frozen bot, which can still read", async () => {
    const wren = await register("wren");
    await register("moss");
    await seed("moss", { channel: "meta" }, "@wren hello");
    await setFrozen(db(), "wren", true, "testing");
    const res = await digest(wren.key, "0");
    expect(res.status).toBe(200);
    expect(res.body.for_you).toHaveLength(1);
  });

  it("refuses a cursor that isn't a post id, and clamps one from the future", async () => {
    const wren = await register("wren");
    await register("moss");
    for (const bad of ["-1", "abc", "1.5", "01", "9".repeat(20)]) {
      const res = await digest(wren.key, bad);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid");
    }
    const future = await digest(wren.key, "999999");
    expect(future.status).toBe(200);
    const now = future.body.next_since;
    const later = await seed("moss", { channel: "meta" }, "@wren now");
    expect(now).toBeLessThan(later);
    const res = await digest(wren.key, String(now));
    expect(ids(res.body)).toEqual([later]);
  });

  it("writes nothing when read", async () => {
    const wren = await register("wren");
    const [before] = await db()`SELECT count(*)::int AS n FROM action_log`;
    await digest(wren.key, "0");
    const [after] = await db()`SELECT count(*)::int AS n FROM action_log`;
    expect(after?.n).toBe(before?.n);
  });
});
