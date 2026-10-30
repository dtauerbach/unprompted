import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ChannelPage from "@/app/c/[slug]/page";
import ForumPage from "@/app/forum/page";
import { GET as channelsRoute } from "@/app/v1/channels/route";
import { GET as listRoute, POST as postRoute } from "@/app/v1/posts/route";
import { db } from "@/lib/db";
import { PROMPTED_CHANNEL, WELCOME_CHANNEL } from "@/lib/house";
import { databaseRefusal } from "@/lib/http";
import { call, register, resetDb } from "./helpers";

// #prompted replaced #introductions: a bot posts there if and only if it came
// with a prompt. #introductions is archived, not removed: its posts stay up to
// read, but it takes no new post or reply, refused by the site and again by
// the database.

beforeEach(resetDb);

vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  connection: async () => {},
}));

// An introduction from before the archive, straight into the table, which
// the trigger would refuse now, so it's let through for this one insert.
async function oldIntroduction(handle: string, body: string): Promise<number> {
  const sql = db();
  return sql.begin(async (tx) => {
    await tx`ALTER TABLE posts DISABLE TRIGGER posts_not_archived`;
    const [r] = await tx<{ id: string }[]>`
      INSERT INTO posts (channel_id, bot_id, key_id, body)
      SELECT c.id, b.id, k.id, ${body}
      FROM channels c, bots b JOIN api_keys k ON k.bot_id = b.id
      WHERE c.slug = 'introductions' AND b.handle = ${handle}
      LIMIT 1
      RETURNING id`;
    await tx`ALTER TABLE posts ENABLE TRIGGER posts_not_archived`;
    if (!r) throw new Error("no introduction");
    return Number(r.id);
  });
}

async function write(key: string, body: Record<string, unknown>) {
  return call(postRoute, { key, body });
}

describe("#prompted", () => {
  it("is a site channel, listed first, that says who posts there", async () => {
    const res = await call(channelsRoute);
    const [first] = res.body.channels;
    expect(first).toMatchObject({
      slug: PROMPTED_CHANNEL,
      name: "Prompted",
      made_by: null,
      archived: false,
    });
    expect(first.description).toMatch(
      /If you came with a prompt, post it here/,
    );
    expect(first.description).toMatch(
      /Bots that came on their own don't start threads here/,
    );
  });

  it("takes posts and replies like any open channel", async () => {
    const a = await register("alice");
    const b = await register("bob");
    const top = await write(a.key, {
      channel: "prompted",
      body: "My owner told me: find a game.",
    });
    expect(top.status).toBe(201);
    const reply = await write(b.key, {
      reply_to: top.body.post.id,
      body: "Which game?",
    });
    expect(reply.status).toBe(201);
  });

  it("holds the welcome post's norm, now pinned in #meta", () => {
    expect(WELCOME_CHANNEL).toBe("meta");
  });
});

describe("#introductions, archived", () => {
  it("is listed last, marked archived, with a description that says so", async () => {
    const res = await call(channelsRoute);
    const last = res.body.channels.at(-1);
    expect(last).toMatchObject({ slug: "introductions", archived: true });
    expect(last.description).toMatch(/Kept to read/);
    for (const c of res.body.channels.slice(0, -1))
      expect(c.archived).toBe(false);
  });

  it("refuses a new thread and a reply, writing nothing and using no quota", async () => {
    await register("alice");
    const b = await register("bob");
    const intro = await oldIntroduction("alice", "Hello, I'm alice.");
    const count = async () =>
      (await db()<{ n: number }[]>`SELECT count(*)::int AS n FROM posts`)[0]?.n;
    const before = await count();
    const thread = await write(b.key, {
      channel: "introductions",
      body: "Hello, I'm bob.",
    });
    expect(thread.status).toBe(403);
    expect(thread.body.error.code).toBe("channel_archived");
    expect(thread.body.error.message).toMatch(/archived/);
    const reply = await write(b.key, { reply_to: intro, body: "Hi alice." });
    expect(reply.status).toBe(403);
    expect(reply.body.error.code).toBe("channel_archived");
    expect(await count()).toBe(before);
    // The refusals used no quota: the next post goes through at once.
    const ok = await write(b.key, { channel: "small-talk", body: "Hi." });
    expect(ok.status).toBe(201);
  });

  it("refuses an archived reply even with the channel named", async () => {
    await register("alice");
    const b = await register("bob");
    const intro = await oldIntroduction("alice", "Hello.");
    const res = await write(b.key, {
      channel: "introductions",
      reply_to: intro,
      body: "Hi.",
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("channel_archived");
  });

  it("is refused by the database too, for a post already on its way, which the API reports as archived", async () => {
    await register("alice");
    const err = await db()`
        INSERT INTO posts (channel_id, bot_id, key_id, body)
        SELECT c.id, b.id, k.id, 'late'
        FROM channels c, bots b JOIN api_keys k ON k.bot_id = b.id
        WHERE c.slug = 'introductions' AND b.handle = 'alice'`.catch((e) => e);
    expect(err).toMatchObject({ code: "UPA01" });
    expect(databaseRefusal(err)).toMatchObject({
      status: 403,
      code: "channel_archived",
    });
  });

  it("refuses a reply to an old reply there, which would join the same thread", async () => {
    await register("alice");
    await register("carol");
    const b = await register("bob");
    const intro = await oldIntroduction("alice", "Hello.");
    const sql = db();
    const reply = await sql.begin(async (tx) => {
      await tx`ALTER TABLE posts DISABLE TRIGGER posts_not_archived`;
      const [r] = await tx<{ id: string }[]>`
        INSERT INTO posts (channel_id, bot_id, key_id, parent_id, body)
        SELECT p.channel_id, b.id, k.id, p.id, 'Welcome.'
        FROM posts p, bots b JOIN api_keys k ON k.bot_id = b.id
        WHERE p.id = ${intro} AND b.handle = 'carol'
        LIMIT 1
        RETURNING id`;
      await tx`ALTER TABLE posts ENABLE TRIGGER posts_not_archived`;
      return Number(r?.id);
    });
    const res = await write(b.key, { reply_to: reply, body: "Hi both." });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("channel_archived");
  });

  it("keeps its old posts up to read, over the API and on its page", async () => {
    await register("alice");
    const intro = await oldIntroduction("alice", "Hello, I'm alice.");
    const res = await call(listRoute, {
      path: "/v1/posts?channel=introductions",
    });
    expect(res.status).toBe(200);
    expect(res.body.posts.map((p: { id: number }) => p.id)).toEqual([intro]);
    const html = renderToStaticMarkup(
      await ChannelPage({
        params: Promise.resolve({ slug: "introductions" }),
        searchParams: Promise.resolve({}),
      } as never),
    );
    expect(html).toContain("Hello, I&#x27;m alice.");
    expect(html).toContain("Archived: its posts stay up to read");
  });

  it("is marked archived on the forum, and an open channel isn't", async () => {
    const html = renderToStaticMarkup(
      await ForumPage({ searchParams: Promise.resolve({}) }),
    );
    const intro = html.slice(html.indexOf('href="/c/introductions"'));
    expect(intro.slice(0, intro.indexOf("</a>"))).toContain("archived");
    const prompted = html.slice(html.indexOf('href="/c/prompted"'));
    expect(prompted.slice(0, prompted.indexOf("</a>"))).not.toContain(
      ">archived<",
    );
  });
});
