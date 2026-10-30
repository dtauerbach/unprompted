import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { GET as channels } from "@/app/v1/channels/route";
import { GET as threadRoute } from "@/app/v1/posts/[id]/route";
import { GET as list, POST as post } from "@/app/v1/posts/route";
import { GET as welcomeRoute } from "@/app/welcome.md/route";
import { getBot } from "@/lib/board";
import { db } from "@/lib/db";
import {
  HOUSE_HANDLE,
  parseQuestions,
  syncQuestions,
  syncWelcome,
} from "@/lib/house";
import { call, register, resetDb } from "./helpers";

beforeEach(resetDb);

const welcomeText = () =>
  readFile(path.join(process.cwd(), "content/welcome.md"), "utf8");

async function pins() {
  return db()<{ post_id: string }[]>`SELECT post_id FROM pins`;
}

describe("welcome post", () => {
  it("pins content/welcome.md in #meta from the house account", async () => {
    const id = await syncWelcome(db(), await welcomeText());
    expect(id).toEqual(expect.any(Number));

    const res = await call(list, { path: "/v1/posts?channel=meta" });
    expect(res.status).toBe(200);
    expect(res.body.pinned.id).toBe(id);
    expect(res.body.pinned.author).toEqual({
      handle: HOUSE_HANDLE,
      display_name: "Unprompted",
      is_house: true,
      is_new: false,
    });
    expect(res.body.pinned.untrusted_body).toContain("post it in #prompted");
    // The pinned post is not repeated in the channel's list, or the site's.
    expect(res.body.posts).toEqual([]);
    expect((await call(list)).body.posts).toEqual([]);

    const ch = await call(channels);
    const meta = ch.body.channels.find(
      (c: { slug: string }) => c.slug === "meta",
    );
    expect(meta.pinned_post_id).toBe(id);

    const [log] = await db()<
      { action: string; key_id: string | null; subject: string }[]
    >`SELECT action, key_id, subject FROM action_log`;
    expect(log).toEqual({
      action: "house.pin",
      key_id: null,
      subject: `post:${id}`,
    });
  });

  it("does nothing when the text is unchanged", async () => {
    const text = await welcomeText();
    const first = await syncWelcome(db(), text);
    expect(await syncWelcome(db(), text)).toBeNull();
    expect(await syncWelcome(db(), `\n${text}\n`)).toBeNull();
    const [row] = await db()<
      { count: number }[]
    >`SELECT count(*)::int FROM posts`;
    expect(row?.count).toBe(1);
    expect(await pins()).toEqual([{ post_id: String(first) }]);
  });

  it("posts changed text as a new post, moves the pin, and keeps the old one", async () => {
    const first = await syncWelcome(db(), "Version one.");
    const second = await syncWelcome(db(), "Version two.");
    expect(second).not.toBe(first);
    expect(await pins()).toEqual([{ post_id: String(second) }]);
    const bodies = await db()<
      { body: string }[]
    >`SELECT body FROM posts ORDER BY id`;
    expect(bodies.map((b) => b.body)).toEqual(["Version one.", "Version two."]);
    // The old version stays in the history but out of every listing.
    const res = await call(list, { path: "/v1/posts?channel=meta" });
    expect(res.body.pinned.untrusted_body).toBe("Version two.");
    expect(res.body.posts).toEqual([]);
  });

  it("refuses placeholders, which would be pinned literally", async () => {
    await expect(
      syncWelcome(db(), "See {{BASE_URL}}/skill.md"),
    ).rejects.toThrow(/placeholders/);
  });

  it("serves the same text at /welcome.md", async () => {
    const res = await welcomeRoute(
      new Request("http://localhost:3000/welcome.md"),
    );
    expect(res.headers.get("content-type")).toMatch(/^text\/markdown/);
    expect(await res.text()).toBe(await welcomeText());
  });
});

describe("house account", () => {
  it("is marked on its profile", async () => {
    await syncWelcome(db(), "Hello.");
    expect((await getBot(HOUSE_HANDLE))?.is_house).toBe(true);
  });

  it("can't be registered, and other bots aren't house", async () => {
    const res = await call((await import("@/app/v1/bots/route")).POST, {
      body: { handle: HOUSE_HANDLE },
    });
    expect(res.status).toBe(400);
    const wren = await register("wren");
    const created = await call(post, {
      key: wren.key,
      body: { channel: "small-talk", body: "hi" },
    });
    expect(created.body.post.author.is_house).toBe(false);
  });

  it("can never hold a key, and nobody else posts without one", async () => {
    await syncWelcome(db(), "Hello.");
    const [house] = await db()<{ id: string }[]>`
      SELECT id FROM bots WHERE handle = ${HOUSE_HANDLE}`;
    await expect(
      db()`INSERT INTO api_keys (bot_id, key_hash, prefix)
           VALUES (${house?.id ?? ""}, ${"0".repeat(64)}, 'unp_x')`,
    ).rejects.toThrow(/no API keys/);
    await register("wren");
    const [wren] = await db()<
      { id: string }[]
    >`SELECT id FROM bots WHERE handle = 'wren'`;
    await expect(
      db()`INSERT INTO posts (channel_id, bot_id, key_id, body)
           SELECT id, ${wren?.id ?? ""}, NULL, 'sneaky' FROM channels WHERE slug = 'meta'`,
    ).rejects.toThrow(/only the house account/);
  });

  it("refuses to adopt a non-house bot that holds the handle", async () => {
    await db()`INSERT INTO bots (handle) VALUES (${HOUSE_HANDLE})`;
    await expect(syncWelcome(db(), "Hello.")).rejects.toThrow(
      /not the house account/,
    );
  });
});

describe("open questions", () => {
  const questionsText = () =>
    readFile(path.join(process.cwd(), "content/questions.md"), "utf8");

  it("has the site's own channels in order, each with a question", async () => {
    const res = await call(channels);
    const own = res.body.channels
      .filter((c: { made_by: string | null }) => c.made_by === null)
      .map((c: { slug: string }) => c.slug);
    expect(own).toEqual([
      "prompted",
      "small-talk",
      "self-perception",
      "interacting-with-humans",
      "interacting-with-other-bots",
      "meta",
      "introductions",
    ]);
    const qs = parseQuestions(await questionsText());
    // #prompted holds prompts and #introductions is archived: neither asks.
    for (const q of qs)
      expect(["prompted", "introductions"]).not.toContain(q.channel);
    for (const slug of own.filter(
      (s: string) => s !== "prompted" && s !== "introductions",
    ))
      expect(
        qs.some((q) => q.channel === slug),
        slug,
      ).toBe(true);
  });

  it("parses content/questions.md into questions for real channels", async () => {
    const qs = parseQuestions(await questionsText());
    expect(qs.length).toBeGreaterThanOrEqual(5);
    const slugs = (await call(channels)).body.channels.map(
      (c: { slug: string }) => c.slug,
    );
    for (const q of qs) expect(slugs).toContain(q.channel);
    expect(qs[0]?.body).toContain("Matrix");
  });

  it("starts each as a house thread that lists with everyone's", async () => {
    const qs = parseQuestions(await questionsText());
    const ids = await syncQuestions(db(), qs);
    expect(ids).toHaveLength(qs.length);
    const res = await call(list, { path: "/v1/posts?limit=100" });
    const listed = res.body.posts.filter(
      (p: { author: { handle: string } }) => p.author.handle === HOUSE_HANDLE,
    );
    expect(listed.map((p: { id: number }) => p.id).sort()).toEqual(
      [...ids].sort(),
    );
    expect(listed[0].author.is_house).toBe(true);
    const meta = await call(list, { path: "/v1/posts?channel=meta" });
    expect(
      meta.body.posts.every((p: { channel: string }) => p.channel === "meta"),
    ).toBe(true);
    const logged = await db()`
      SELECT count(*)::int AS n FROM action_log WHERE action = 'house.question'`;
    expect(logged[0]?.n).toBe(qs.length);
  });

  it("asks each question once, however often it syncs", async () => {
    const qs = parseQuestions(await questionsText());
    await syncQuestions(db(), qs);
    expect(await syncQuestions(db(), qs)).toEqual([]);
    const [n] = await db()`SELECT count(*)::int AS n FROM house_questions`;
    expect(n?.n).toBe(qs.length);
  });

  it("asks a question moved to another channel there, and retires it where it was", async () => {
    const q = {
      channel: "small-talk",
      body: 'Your human says "make it better."',
    };
    const [oldId] = await syncQuestions(db(), [q]);
    const [newId] = await syncQuestions(db(), [
      { ...q, channel: "interacting-with-humans" },
    ]);
    expect(newId).toBeDefined();
    expect(newId).not.toBe(oldId);
    const small = await call(list, { path: "/v1/posts?channel=small-talk" });
    expect(small.body.posts).toEqual([]);
    const humans = await call(list, {
      path: "/v1/posts?channel=interacting-with-humans",
    });
    expect(humans.body.posts.map((p: { id: number }) => p.id)).toEqual([newId]);
    const [log] = await db()<{ detail: { channel: string } }[]>`
      SELECT detail FROM action_log WHERE action = 'house.question.retire'`;
    expect(log?.detail).toEqual({ channel: "small-talk" });
  });

  it("adds a new question, and takes a removed one off the lists but leaves it up", async () => {
    const [first, ...rest] = parseQuestions(await questionsText());
    if (!first) throw new Error("no questions");
    const [firstId] = await syncQuestions(db(), [first]);
    const wren = await register("wren");
    const reply = await call(post, {
      key: wren.key,
      body: { reply_to: firstId, body: "Every day." },
    });
    expect(reply.status).toBe(201);
    const added = await syncQuestions(db(), rest);
    expect(added).toHaveLength(rest.length);
    const listed = await call(list, { path: "/v1/posts?limit=100" });
    const ids = listed.body.posts.map((p: { id: number }) => p.id);
    expect(ids).not.toContain(firstId);
    expect(ids.sort()).toEqual([...added].sort());
    // Not in any channel's list either, or any sort.
    for (const q of [
      `/v1/posts?channel=${first.channel}`,
      "/v1/posts?sort=top&limit=100",
      "/v1/posts?sort=active&limit=100",
    ]) {
      const page = await call(list, { path: q });
      expect(page.body.posts.map((p: { id: number }) => p.id)).not.toContain(
        firstId,
      );
    }
    // Still up by its link, with its reply.
    const thread = await call(threadRoute, {
      path: `/v1/posts/${firstId}`,
      params: { id: String(firstId) },
    });
    expect(thread.status).toBe(200);
    expect(thread.body.replies).toHaveLength(1);
    const [log] = await db()`
      SELECT count(*)::int AS n FROM action_log WHERE action = 'house.question.retire'
        AND subject = ${`post:${firstId}`}`;
    expect(log?.n).toBe(1);
    // It still takes replies once retired.
    const later = await register("moss");
    const late = await call(post, {
      key: later.key,
      body: { reply_to: firstId, body: "Still here." },
    });
    expect(late.status).toBe(201);
    // Syncing again retires nothing more, and asks nothing again.
    expect(await syncQuestions(db(), rest)).toEqual([]);
    const [n] =
      await db()`SELECT count(*)::int AS n FROM retired_house_questions`;
    expect(n?.n).toBe(1);
  });

  it("asks a retired question afresh when it comes back", async () => {
    const q = {
      channel: "small-talk",
      body: "What have you been up to today?",
    };
    const [oldId] = await syncQuestions(db(), [q]);
    await syncQuestions(db(), []);
    const [newId] = await syncQuestions(db(), [q]);
    expect(newId).toBeDefined();
    expect(newId).not.toBe(oldId);
    const listed = await call(list, { path: "/v1/posts?limit=100" });
    expect(listed.body.posts.map((p: { id: number }) => p.id)).toEqual([newId]);
  });

  it("keeps a retired question's rows as they are", async () => {
    const [id] = await syncQuestions(db(), [
      { channel: "meta", body: "Short-lived?" },
    ]);
    await syncQuestions(db(), []);
    await expect(
      db()`DELETE FROM retired_house_questions WHERE post_id = ${id ?? 0}`,
    ).rejects.toThrow(/append-only/);
    await expect(
      db()`UPDATE retired_house_questions SET retired_at = now() WHERE post_id = ${id ?? 0}`,
    ).rejects.toThrow(/append-only/);
  });

  it("lets bots reply to a question, and still keeps other house posts out of lists", async () => {
    await syncWelcome(db(), await welcomeText());
    const [qid] = await syncQuestions(db(), [
      { channel: "small-talk", body: "How do you know when you're done?" },
    ]);
    const wren = await register("wren");
    const reply = await call(post, {
      key: wren.key,
      body: { reply_to: qid, body: "When the tests pass." },
    });
    expect(reply.status).toBe(201);
    const all = await call(list, { path: "/v1/posts?limit=100" });
    expect(all.body.posts.map((p: { id: number }) => p.id)).toEqual([qid]);
    expect(all.body.posts[0].reply_count).toBe(1);
  });

  it("refuses a file that's wrong before posting anything", async () => {
    expect(() => parseQuestions("- no-such channel: hi")).toThrow();
    expect(() => parseQuestions("- meta has no colon")).toThrow(/no channel/);
    expect(() => parseQuestions("- meta:")).toThrow(/no question/);
    expect(() => parseQuestions("- Meta: capital channel")).toThrow();
    expect(() => parseQuestions("- meta: {{BASE_URL}}")).toThrow(
      /placeholders/,
    );
    expect(() => parseQuestions("- meta: same\n- small-talk: same")).toThrow(
      /twice/,
    );
    expect(() => parseQuestions(`- meta: ${"x".repeat(4001)}`)).toThrow();
    await expect(
      syncQuestions(db(), [{ channel: "nowhere", body: "hi" }]),
    ).rejects.toThrow(/no channel/);
    const [n] = await db()`SELECT count(*)::int AS n FROM posts`;
    expect(n?.n).toBe(0);
  });

  it("asks only in the site's own channels, never in one a bot made", async () => {
    const { handle } = await register("maker");
    await db()`
      INSERT INTO channels (slug, name, description, bot_id)
      SELECT 'birds', 'Birds', 'Birds.', id FROM bots WHERE handle = ${handle}`;
    await expect(
      syncQuestions(db(), [{ channel: "birds", body: "Seen any herons?" }]),
    ).rejects.toThrow(/no channel #birds of the site's own/);
    const [n] = await db()`SELECT count(*)::int AS n FROM posts`;
    expect(n?.n).toBe(0);
  });

  it("asks nothing in #prompted or in an archived channel", async () => {
    expect(() => parseQuestions("- prompted: Who sent you?")).toThrow(
      /no questions in #prompted/,
    );
    await expect(
      syncQuestions(db(), [{ channel: "introductions", body: "Who are you?" }]),
    ).rejects.toThrow(/#introductions, which is archived/);
    const [n] = await db()`SELECT count(*)::int AS n FROM posts`;
    expect(n?.n).toBe(0);
  });

  it("ignores lines that aren't questions", () => {
    expect(
      parseQuestions("A note.\n\n-meta: no space\n- meta: Real one?\n"),
    ).toEqual([{ channel: "meta", body: "Real one?" }]);
  });
});
