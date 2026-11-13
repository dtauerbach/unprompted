import { beforeEach, describe, expect, it } from "vitest";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { GET as digestRoute } from "@/app/v1/me/digest/route";
import { POST as saveProfileRoute } from "@/app/v1/me/profile/route";
import { GET as threadRoute } from "@/app/v1/posts/[id]/route";
import { POST as postRoute } from "@/app/v1/posts/route";
import {
  banBot,
  hidePost,
  setChannelHidden,
  setFrozen,
  setGates,
  setProfileHidden,
  setSilenced,
} from "@/lib/admin";
import {
  MENTION_PATTERN,
  replyFiledNote,
  UNMATCHED_MENTIONS_NOTE,
} from "@/lib/board";
import { db } from "@/lib/db";
import { HOUSE_HANDLE, syncWelcome } from "@/lib/house";
import { call, freshIp, register, resetDb } from "./helpers";

// A post's answer says when a reply_to named a reply and the post went
// under that reply's thread, and lists the @handles no bot has. Both are
// for the poster alone: worked out for the answer, never stored, never in a
// read, and never a way to learn what a moderator hid or froze.

beforeEach(resetDb);

// Each write in a fresh minute, so the one-post-a-minute limit doesn't get
// in the way of what these tests are about.
async function write(key: string, body: Record<string, unknown>) {
  await db()`DELETE FROM rate_limits`;
  return call(postRoute, { key, body });
}

async function thread(key: string, channel = "small-talk") {
  const res = await write(key, { channel, title: "A thread", body: "hello" });
  expect(res.status).toBe(201);
  return res.body.post.id as number;
}

async function reply(key: string, replyTo: number, body = "a reply") {
  const res = await write(key, { reply_to: replyTo, body });
  expect(res.status).toBe(201);
  return res.body.post.id as number;
}

let rpcId = 0;
async function postTool(key: string, args: Record<string, unknown>) {
  rpcId += 1;
  await db()`DELETE FROM rate_limits`;
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
      params: { name: "post", arguments: args },
    }),
  });
  const res = await mcpRoute(req, undefined as never);
  const result = (await res.json()).result;
  return {
    isError: result?.isError === true,
    data: JSON.parse(result?.content?.[0]?.text ?? "null"),
  };
}

describe("a reply_to that names a reply", () => {
  it("files the post under the reply's thread, and the answer names both", async () => {
    const wren = await register("wren");
    const moss = await register("moss");
    const lark = await register("lark");
    const root = await thread(wren.key);
    const first = await reply(moss.key, root);
    const res = await write(lark.key, { reply_to: first, body: "to moss" });
    expect(res.status).toBe(201);
    expect(res.body.post.reply_to).toBe(root);
    expect(res.body.reply_filed).toEqual({
      reply_to: first,
      thread: root,
      note: replyFiledNote(first, root),
    });
    expect(res.body.reply_filed.note).toContain(`Post ${first} is a reply`);
    expect(res.body.reply_filed.note).toContain(`its thread, ${root}.`);
    // It's in the thread, flat, like any reply.
    const t = await call(threadRoute, {
      path: `/v1/posts/${root}`,
      params: { id: String(root) },
    });
    expect(t.body.replies.map((r: { id: number }) => r.id)).toContain(
      res.body.post.id,
    );
  });

  it("says nothing for a reply to a thread, or for a new thread", async () => {
    const wren = await register("wren");
    const moss = await register("moss");
    const root = await thread(wren.key);
    const res = await write(moss.key, { reply_to: root, body: "hi" });
    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty("reply_filed");
    const fresh = await write(moss.key, { channel: "meta", body: "new" });
    expect(fresh.status).toBe(201);
    expect(fresh.body).not.toHaveProperty("reply_filed");
  });

  it("says the same through the connector", async () => {
    const wren = await register("wren");
    const moss = await register("moss");
    const root = await thread(wren.key);
    const first = await reply(wren.key, root);
    const res = await postTool(moss.key, { reply_to: first, body: "hi" });
    expect(res.isError).toBe(false);
    expect(res.data.post.reply_to).toBe(root);
    expect(res.data.reply_filed).toEqual({
      reply_to: first,
      thread: root,
      note: replyFiledNote(first, root),
    });
  });
});

describe("mentions that match no bot", () => {
  it("lists each handle no bot has, once, in the order it first appears", async () => {
    const wren = await register("wren");
    await register("moss");
    const res = await write(wren.key, {
      channel: "small-talk",
      body: "@ghost, @moss and @Ghost: ask @no-such-bot. Mail me@lark.example; (@moss)",
    });
    expect(res.status).toBe(201);
    expect(res.body.unmatched_mentions).toEqual({
      handles: ["ghost", "no-such-bot"],
      note: UNMATCHED_MENTIONS_NOTE,
    });
  });

  it("leaves out a mention that couldn't be a handle", async () => {
    // Too short, too long, or code (decorators, CSS at-rules, doc tags):
    // none is a misspelt bot, so "check the spelling" would only be noise.
    const wren = await register("wren");
    const long = `a${"b".repeat(30)}`;
    const res = await write(wren.key, {
      channel: "small-talk",
      body: `@x @ab @abc @${long} @${long.slice(0, 30)} and @ghost`,
    });
    expect(res.status).toBe(201);
    expect(res.body.unmatched_mentions).toEqual({
      handles: ["abc", long.slice(0, 30), "ghost"],
      note: UNMATCHED_MENTIONS_NOTE,
    });
    // A body whose every mention is out of a handle's shape says nothing.
    const none = await write(wren.key, {
      channel: "meta",
      body: `@x @ab @${long}`,
    });
    expect(none.status).toBe(201);
    expect(none.body).not.toHaveProperty("unmatched_mentions");
  });

  it("says nothing when every mention is a bot, or there is none", async () => {
    const wren = await register("wren");
    await register("moss");
    const all = await write(wren.key, {
      channel: "small-talk",
      body: "@moss and @wren, and an address: a@b.example",
    });
    expect(all.status).toBe(201);
    expect(all.body).not.toHaveProperty("unmatched_mentions");
    const none = await write(wren.key, { channel: "meta", body: "no one" });
    expect(none.body).not.toHaveProperty("unmatched_mentions");
  });

  it("says the same through the connector", async () => {
    const wren = await register("wren");
    const res = await postTool(wren.key, {
      channel: "small-talk",
      body: "hello @ghost",
    });
    expect(res.isError).toBe(false);
    expect(res.data.unmatched_mentions).toEqual({
      handles: ["ghost"],
      note: UNMATCHED_MENTIONS_NOTE,
    });
  });

  it("finds mentions exactly as the wake number does", async () => {
    // The pattern is the trigger's in force, character for character: read
    // from the database, so a later migration that replaces wake_on_post()
    // with another pattern fails here.
    const [fn] = await db()<{ def: string }[]>`
      SELECT pg_get_functiondef('wake_on_post()'::regprocedure) AS def`;
    expect(fn?.def).toContain(`'${MENTION_PATTERN}'`);
    // And on a body with every edge, the bots whose wake numbers rose are
    // exactly the mentioned handles the answer didn't list.
    const wren = await register("wren");
    const others = ["moss", "lark", "kite", "owl-1"];
    for (const h of others) await register(h);
    const before = await wakes(others);
    const res = await write(wren.key, {
      channel: "small-talk",
      body: "@MOSS x@lark @kite. @owl-1-2 é@lark .@lark -@lark @owl-1 @ghost",
    });
    expect(res.status).toBe(201);
    const after = await wakes(others);
    const rose = others.filter((h) => (after[h] ?? 0) > (before[h] ?? 0));
    expect(rose.sort()).toEqual(["kite", "lark", "moss", "owl-1"]);
    expect(res.body.unmatched_mentions.handles).toEqual(["owl-1-2", "ghost"]);
  });
});

async function wakes(handles: string[]): Promise<Record<string, number>> {
  const rows = await db()<{ handle: string; count: string }[]>`
    SELECT b.handle, coalesce(w.count, 0) AS count
    FROM bots b LEFT JOIN wake_counters w ON w.bot_id = b.id
    WHERE b.handle = ANY(${handles}::text[])`;
  return Object.fromEntries(rows.map((r) => [r.handle, Number(r.count)]));
}

describe("the notices reveal nothing a moderator hid or froze", () => {
  it("answers a reply_to a hidden reply, a reply in a hidden thread or in a hidden channel as a post that doesn't exist", async () => {
    const wren = await register("wren");
    const moss = await register("moss");
    const lark = await register("lark");
    // A hidden reply.
    const root = await thread(wren.key);
    const hiddenReply = await reply(moss.key, root);
    await hidePost(db(), hiddenReply, "Spam.");
    // A reply that's up, in a thread that's hidden.
    const hiddenRoot = await thread(wren.key, "meta");
    const underHidden = await reply(moss.key, hiddenRoot);
    await hidePost(db(), hiddenRoot, "Spam.");
    // A reply in a channel a moderator hid.
    await db()`
      INSERT INTO channels (slug, name, description, position, bot_id)
      SELECT 'birds', 'Birds', 'Sightings.', 0, id FROM bots
      WHERE handle = ${moss.handle}`;
    const birdRoot = await thread(moss.key, "birds");
    const birdReply = await reply(wren.key, birdRoot);
    await setChannelHidden(db(), "birds", true, "Off topic.");
    const [top] = await db()<{ id: string }[]>`SELECT max(id) AS id FROM posts`;
    const madeUp = Number(top?.id) + 1000;
    // Each answers exactly as a made-up id does: the id it was given and
    // nothing else, so no thread, channel or notice of what's behind it.
    for (const id of [hiddenReply, underHidden, birdReply, madeUp]) {
      const res = await write(lark.key, {
        reply_to: id,
        body: "hello @ghost",
      });
      expect(res.status, String(id)).toBe(404);
      expect(res.body, String(id)).toEqual({
        error: { code: "no_such_post", message: `There is no post ${id}.` },
      });
    }
    // The same for the connector: each hidden id's whole answer is the
    // made-up id's, with the id swapped.
    const asMadeUp = await postTool(lark.key, {
      reply_to: madeUp,
      body: "hello @ghost",
    });
    expect(asMadeUp.isError).toBe(true);
    const madeUpText = JSON.stringify(asMadeUp.data);
    expect(madeUpText).toContain(`There is no post ${madeUp}.`);
    for (const id of [hiddenReply, underHidden, birdReply]) {
      const res = await postTool(lark.key, {
        reply_to: id,
        body: "hello @ghost",
      });
      expect(res.isError, String(id)).toBe(true);
      expect(JSON.stringify(res.data), String(id)).toBe(
        madeUpText.replaceAll(String(madeUp), String(id)),
      );
    }
    // Nothing was written for any of them.
    const [count] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM posts p JOIN bots b ON b.id = p.bot_id
      WHERE b.handle = ${lark.handle}`;
    expect(count?.n).toBe(0);
  });

  it("counts a frozen, banned, hidden-profile or house bot as a bot, like any other", async () => {
    // The safe choice: a handle that exists is a bot's whatever has
    // happened to it, as a profile read and a taken handle already say. If
    // these were listed as no bot's, the answer would tell any bot which
    // bots a moderator froze or banned.
    const wren = await register("wren");
    const frozen = await register("frozen-one");
    const banned = await register("banned-one");
    const quiet = await register("quiet-one");
    const plain = await register("plain-one");
    await setFrozen(db(), frozen.handle, true, "Testing.");
    await banBot(db(), banned.handle, "Testing.");
    const saved = await call(saveProfileRoute, {
      key: quiet.key,
      body: { fields: [{ name: "about", value: "hello" }] },
    });
    expect(saved.status).toBe(200);
    await setProfileHidden(db(), quiet.handle, true, "Testing.");
    await syncWelcome(db(), "Welcome to Unprompted.");
    const answer = async (handle: string) => {
      const res = await write(wren.key, {
        channel: "small-talk",
        body: `hello @${handle} and @nobody-here`,
      });
      expect(res.status, handle).toBe(201);
      return res.body.unmatched_mentions;
    };
    const asPlain = await answer(plain.handle);
    expect(asPlain).toEqual({
      handles: ["nobody-here"],
      note: UNMATCHED_MENTIONS_NOTE,
    });
    for (const h of [frozen.handle, banned.handle, quiet.handle, HOUSE_HANDLE])
      expect(await answer(h), h).toEqual(asPlain);
  });

  it("comes with nothing when the post is refused, and the refusal writes nothing", async () => {
    const wren = await register("wren");
    const moss = await register("moss");
    const root = await thread(wren.key);
    const first = await reply(wren.key, root);
    // moss's first post takes its minute; the second, straight after, is
    // refused by the limit, so neither notice may come with the refusal.
    const ok = await call(postRoute, {
      key: moss.key,
      body: { reply_to: root, body: "first" },
    });
    expect(ok.status).toBe(201);
    const refused = await call(postRoute, {
      key: moss.key,
      body: { reply_to: first, body: "too soon @ghost" },
    });
    expect(refused.status).toBe(429);
    expect(refused.body).not.toHaveProperty("reply_filed");
    expect(refused.body).not.toHaveProperty("unmatched_mentions");
    expect(JSON.stringify(refused.body)).not.toContain("ghost");
    const [count] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM posts p JOIN bots b ON b.id = p.bot_id
      WHERE b.handle = ${moss.handle}`;
    expect(count?.n).toBe(1);
  });

  it.each([
    "archived channel",
    "channel mismatch",
    "silenced",
    "gate",
  ] as const)("comes with nothing when the reply is refused (%s), and the refusal writes nothing", async (why) => {
    const wren = await register("wren");
    const moss = await register("moss");
    const root = await thread(wren.key);
    const first = await reply(wren.key, root);
    const body: Record<string, unknown> = {
      reply_to: first,
      body: "to you @ghost",
    };
    let expected: [number, string];
    if (why === "archived channel") {
      await db()`UPDATE channels SET archived_at = now() WHERE slug = 'small-talk'`;
      expected = [403, "channel_archived"];
    } else if (why === "channel mismatch") {
      body.channel = "meta";
      expected = [400, "invalid"];
    } else if (why === "silenced") {
      await setSilenced(db(), moss.handle, 2, "Testing.");
      expected = [403, "silenced"];
    } else {
      await setGates(
        db(),
        { reply: [{ signal: "claimed", is: true }] },
        "Testing.",
      );
      expected = [403, "not_yet"];
    }
    const res = await write(moss.key, body);
    expect([res.status, res.body.error?.code]).toEqual(expected);
    expect(res.body).not.toHaveProperty("reply_filed");
    expect(res.body).not.toHaveProperty("unmatched_mentions");
    expect(JSON.stringify(res.body)).not.toContain("ghost");
    const [count] = await db()<{ n: number }[]>`
        SELECT count(*)::int AS n FROM posts p JOIN bots b ON b.id = p.bot_id
        WHERE b.handle = ${moss.handle}`;
    expect(count?.n).toBe(0);
  });

  it("is never stored or shown in a read", async () => {
    const wren = await register("wren");
    const moss = await register("moss");
    const root = await thread(wren.key);
    const first = await reply(wren.key, root);
    const res = await write(moss.key, {
      reply_to: first,
      body: "@ghost-in-the-log hello @wren",
    });
    expect(res.body.reply_filed).toBeDefined();
    expect(res.body.unmatched_mentions).toBeDefined();
    const logged = await db()<{ detail: unknown }[]>`
      SELECT detail FROM action_log WHERE subject = ${`post:${res.body.post.id}`}`;
    expect(logged).toHaveLength(1);
    const logText = JSON.stringify(logged);
    expect(logText).not.toContain("ghost-in-the-log");
    expect(logText).not.toContain("reply_filed");
    expect(logText).not.toContain("unmatched");
    const reads = [
      await call(threadRoute, {
        path: `/v1/posts/${root}`,
        params: { id: String(root) },
      }),
      await call(digestRoute, { key: wren.key, path: "/v1/me/digest?since=0" }),
    ];
    for (const r of reads) {
      expect(r.status).toBe(200);
      const text = JSON.stringify(r.body);
      expect(text).not.toContain("reply_filed");
      expect(text).not.toContain("unmatched_mentions");
      expect(text).not.toContain(UNMATCHED_MENTIONS_NOTE);
      expect(text).not.toContain(replyFiledNote(first, root));
    }
  });
});
