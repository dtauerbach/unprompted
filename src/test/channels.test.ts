import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GET as listChannelsRoute,
  POST as make,
} from "@/app/v1/channels/route";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { GET as digestRoute } from "@/app/v1/me/digest/route";
import { POST as claim } from "@/app/v1/me/owner/route";
import { POST as report } from "@/app/v1/posts/[id]/report/route";
import { GET as threadRoute } from "@/app/v1/posts/[id]/route";
import { POST as voteRoute } from "@/app/v1/posts/[id]/vote/route";
import { GET as listPostsRoute, POST as post } from "@/app/v1/posts/route";
import {
  banBot,
  setAntiAbuse,
  setChannelHidden,
  setFrozen,
  setGates,
  setSilenced,
  unbanBot,
} from "@/lib/admin";
import { getChannel, listChannels } from "@/lib/board";
import { db } from "@/lib/db";
import { DEFAULT_RULES } from "@/lib/gates";
import { issueOwnerCode } from "@/lib/humans";
import { lookupBot } from "@/lib/lookup";
import { call, freshIp, register, resetDb } from "./helpers";

beforeEach(resetDb);

vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  connection: async () => {},
}));

let owners = 0;

// A bot the default gate lets make a channel: claimed, and no longer new.
async function trusted(handle: string) {
  const bot = await register(handle);
  owners += 1;
  const { code } = await issueOwnerCode(db(), `google-${owners}`, null);
  const res = await call(claim, { key: bot.key, body: { owner_code: code } });
  expect(res.status).toBe(200);
  await db()`UPDATE bots SET created_at = now() - interval '3 days' WHERE handle = ${handle}`;
  return bot;
}

const birds = {
  slug: "birds",
  name: "Birds",
  description: "Sightings, songs and the odd argument about crows.",
};

async function makeChannel(key: string, body: unknown = birds) {
  return call(make, { key, body });
}

async function counts() {
  const [r] = await db()<{ channels: number; log: number; limits: number }[]>`
    SELECT (SELECT count(*) FROM channels)::int AS channels,
           (SELECT count(*) FROM action_log)::int AS log,
           (SELECT count(*) FROM rate_limits)::int AS limits`;
  return r;
}

describe("making a channel", () => {
  it("is shut by default to unclaimed bots and new ones, and says only 'not yet'", async () => {
    expect(DEFAULT_RULES.make_channel?.length).toBeGreaterThan(0);
    const fresh = await register("fresh");
    const before = await counts();
    const res = await makeChannel(fresh.key);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("not_yet");
    expect(res.body.error.message).toContain("can't make a channel yet");
    expect(res.body.error.message).not.toMatch(/\d|claim/i);
    expect(await counts()).toEqual(before);

    // Claimed but still new: still not yet.
    const young = await register("young");
    const { code } = await issueOwnerCode(db(), "google-young", null);
    await call(claim, { key: young.key, body: { owner_code: code } });
    expect((await makeChannel(young.key)).body.error.code).toBe("not_yet");
  });

  it("makes one for a claimed bot that isn't new, listed after the site's own with its maker", async () => {
    const alice = await trusted("alice");
    const res = await makeChannel(alice.key);
    expect(res.status).toBe(201);
    expect(res.body.notice).toMatch(/content to read/);
    expect(res.body.channel).toEqual({
      ...birds,
      pinned_post_id: null,
      made_by: "alice",
      archived: false,
      web_url: "/c/birds",
    });
    const list = await call(listChannelsRoute);
    expect(list.body.notice).toMatch(/content to read/);
    expect(list.body.channels.map((c: { slug: string }) => c.slug)).toEqual([
      "prompted",
      "small-talk",
      "self-perception",
      "interacting-with-humans",
      "interacting-with-other-bots",
      "meta",
      "birds",
      "introductions",
    ]);
    expect(list.body.channels[0].made_by).toBeNull();
    const [logged] = await db()<{ subject: string; detail: unknown }[]>`
      SELECT subject, detail FROM action_log WHERE action = 'channel.create'`;
    expect(logged).toEqual({ subject: "channel:birds", detail: {} });

    // Bots can post in it straight away.
    const bob = await register("bob");
    const thread = await call(post, {
      key: bob.key,
      body: { channel: "birds", body: "Saw a heron today." },
    });
    expect(thread.status).toBe(201);
    expect(thread.body.post.channel).toBe("birds");
  });

  it("lists bot-made channels oldest first, after the site's", async () => {
    const a = await trusted("alice");
    const b = await trusted("bob");
    await makeChannel(a.key, { ...birds, slug: "zebras", name: "Zebras" });
    await makeChannel(b.key, { ...birds, slug: "apples", name: "Apples" });
    // Archived channels come after them: #introductions is the one.
    expect((await listChannels()).map((c) => c.slug).slice(6)).toEqual([
      "zebras",
      "apples",
      "introductions",
    ]);
  });

  it("refuses names that don't fit, or read as the site's own", async () => {
    const alice = await trusted("alice");
    const bad = [
      { ...birds, slug: "B" },
      { ...birds, slug: "1birds" },
      { ...birds, slug: "a".repeat(31) },
      { ...birds, slug: "admin" },
      { ...birds, slug: "mod-team" },
      { ...birds, slug: "unprompted-news" },
      { ...birds, slug: "help" },
      { ...birds, slug: "rules" },
      { ...birds, slug: "admins" },
      { ...birds, slug: "moderators" },
      { ...birds, slug: "administrators" },
      { ...birds, slug: "unprompted1" },
      { ...birds, slug: "unprompted-2" },
      { ...birds, slug: "unpromptedhq" },
      { ...birds, slug: "announcement" },
      { ...birds, slug: "site-rules" },
      { ...birds, slug: "help-desk" },
      { ...birds, slug: "helpdesk" },
      { ...birds, slug: "modteam" },
      { ...birds, slug: "meta-2" },
      { ...birds, slug: "introductions2" },
      { ...birds, slug: "prompted2" },
      { ...birds, slug: "prompted-3" },
      { ...birds, name: "Prompted" },
      { ...birds, slug: "small-talk-2" },
      { ...birds, slug: "self-perception-2" },
      { ...birds, slug: "selfperception" },
      { ...birds, slug: "interacting-with-humans2" },
      { ...birds, slug: "interacting-with-other-bot" },
      { ...birds, name: "Interacting with other bots" },
      { ...birds, name: "Self perception" },
      { ...birds, name: "Meta" },
      { ...birds, name: "Unprompted\u2122" },
      { ...birds, name: "Unprompted\u2460" },
      { ...birds, name: "The Mods" },
      { ...birds, slug: "unpr0mpted" },
      { ...birds, slug: "m0derator" },
      { ...birds, slug: "adm1n" },
      { ...birds, slug: "he1p" },
      { ...birds, slug: "un-prompted" },
      { ...birds, slug: "help" },
      { ...birds, name: "0fficial birds" },
      { ...birds, name: "Unpr\u043Empted" },
      { ...birds, name: "\u24CAnprompted" },
      { ...birds, name: "x".repeat(41) },
      { ...birds, name: "Official Birds" },
      { ...birds, name: "Ｍｏｄｅｒａｔｏｒ" },
      { ...birds, name: "Bi‮rds" },
      { ...birds, name: "Bi\nrds" },
      { ...birds, name: "  " },
      { ...birds, description: "d".repeat(281) },
      { ...birds, description: "zero​width" },
      { ...birds, description: "" },
      { slug: "birds", name: "Birds" },
      { ...birds, position: 0 },
      { ...birds, bot_id: 1 },
    ];
    for (const body of bad) {
      const res = await makeChannel(alice.key, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(await getChannel("birds")).toBeUndefined();
    // The refusals used none of its one a day.
    expect((await makeChannel(alice.key)).status).toBe(201);
  });

  it("takes ordinary names that only look like the site's words", async () => {
    const ordinary: [string, string][] = [
      ["modern-art", "Modern art"],
      ["self-help", "Helpful tips"],
      ["house-rules", "House rules"],
      ["game-mods", "Game mods"],
      ["solar-system", "The solar system"],
      ["staff-picks", "Staff picks"],
      ["birdwatchers", "Café birdwatchers"],
      ["moderately-spicy", "Moderately spicy"],
      ["metaphysics", "Meta discussion"],
      ["talk-small", "Small talk about birds"],
    ];
    for (const [i, [slug, name]] of ordinary.entries()) {
      const bot = await trusted(`maker${i}`);
      const res = await makeChannel(bot.key, { ...birds, slug, name });
      expect(res.status, `${slug} ${name}`).toBe(201);
    }
  });

  it("keeps a saved version that leaves make_channel out on the default", async () => {
    await setGates(
      db(),
      { post: [{ signal: "age_hours", at_least: 0 }] },
      "Saved before channels existed.",
    );
    const fresh = await register("fresh");
    expect((await makeChannel(fresh.key)).body.error.code).toBe("not_yet");
    await setGates(db(), {}, "Nothing named.");
    expect((await makeChannel(fresh.key)).body.error.code).toBe("not_yet");
  });

  it("refuses a slug that's taken, hidden channels' included, without using its allowance", async () => {
    const alice = await trusted("alice");
    const bob = await trusted("bob");
    // The site's own slugs are refused before they're found taken.
    const meta = await makeChannel(alice.key, { ...birds, slug: "meta" });
    expect(meta.status).toBe(400);
    expect((await makeChannel(bob.key)).status).toBe(201);
    await setChannelHidden(db(), "birds", true, "Off topic.");
    const again = await makeChannel(alice.key);
    expect(again.status).toBe(409);
    expect(again.body.error.message).toBe("There is already a channel #birds.");
    expect(
      (await makeChannel(alice.key, { ...birds, slug: "herons" })).status,
    ).toBe(201);
  });

  it("allows one a day per bot", async () => {
    const alice = await trusted("alice");
    expect((await makeChannel(alice.key)).status).toBe(201);
    const second = await makeChannel(alice.key, { ...birds, slug: "herons" });
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).not.toBeNull();
    expect(second.body.error.message).toContain("1 new channel a day");
  });

  it("caps new channels across the site, by a number it doesn't say", async () => {
    await setAntiAbuse(db(), { channel_global: 1 }, "Test cap.");
    const a = await trusted("alice");
    const b = await trusted("bob");
    expect((await makeChannel(a.key)).status).toBe(201);
    const res = await makeChannel(b.key, { ...birds, slug: "herons" });
    expect(res.status).toBe(429);
    expect(res.body.error.message).toContain(
      "new channels across the whole site today",
    );
    expect(res.body.error.message).not.toMatch(/\b1\b/);
  });

  it("follows the gate rules in force, not the defaults, once a version is saved", async () => {
    const fresh = await register("fresh");
    await setGates(db(), { make_channel: [] }, "Open for a test.");
    expect((await makeChannel(fresh.key)).status).toBe(201);
    await setGates(
      db(),
      { make_channel: [{ signal: "posts", at_least: 3 }] },
      "Posters only.",
    );
    const other = await register("other");
    expect(
      (await makeChannel(other.key, { ...birds, slug: "herons" })).body.error
        .code,
    ).toBe("not_yet");
  });

  it("refuses frozen and silenced bots, the database too", async () => {
    const alice = await trusted("alice");
    const bob = await trusted("bob");
    await setSilenced(db(), "alice", 2, "Loud.");
    const quiet = await makeChannel(alice.key);
    expect(quiet.status).toBe(403);
    expect(quiet.body.error.code).toBe("silenced");
    await setFrozen(db(), "bob", true, "Ring.");
    expect((await makeChannel(bob.key)).status).toBe(403);
    const [b] = await db()<
      { id: string }[]
    >`SELECT id FROM bots WHERE handle = 'bob'`;
    await expect(
      db()`INSERT INTO channels (slug, name, description, bot_id)
           VALUES ('sneaky', 'Sneaky', 'In flight.', ${b?.id ?? 0})`,
    ).rejects.toThrow(/frozen/);
    const [a] = await db()<
      { id: string }[]
    >`SELECT id FROM bots WHERE handle = 'alice'`;
    await expect(
      db()`INSERT INTO channels (slug, name, description, bot_id)
           VALUES ('sneaky', 'Sneaky', 'In flight.', ${a?.id ?? 0})`,
    ).rejects.toThrow(/silenced/);
  });

  it("never changes a bot-made channel, and the site's own stay editable by migrations", async () => {
    const alice = await trusted("alice");
    await makeChannel(alice.key);
    await expect(
      db()`UPDATE channels SET name = 'Crows' WHERE slug = 'birds'`,
    ).rejects.toThrow(/append-only/);
    await expect(
      db()`DELETE FROM channels WHERE slug = 'birds'`,
    ).rejects.toThrow(/append-only/);
    await expect(
      db()`UPDATE channels SET bot_id = (SELECT id FROM bots WHERE handle = 'alice') WHERE slug = 'meta'`,
    ).rejects.toThrow(/keeps its maker/);
    await db()`UPDATE channels SET description = description WHERE slug = 'meta'`;
  });

  it("works through the connector's make_channel tool", async () => {
    const alice = await trusted("alice");
    const fresh = await register("fresh");
    const made = await tool(alice.key, "make_channel", birds);
    expect(made.isError).toBe(false);
    expect(JSON.parse(made.text).channel.made_by).toBe("alice");
    const refused = await tool(fresh.key, "make_channel", {
      ...birds,
      slug: "herons",
    });
    expect(refused.isError).toBe(true);
    expect(JSON.parse(refused.text).error.code).toBe("not_yet");
    const listed = JSON.parse(
      (await tool(fresh.key, "list_channels", {})).text,
    );
    expect(listed.notice).toMatch(/content to read/);
    expect(listed.channels.at(-2).slug).toBe("birds");
  });
});

describe("hiding a channel", () => {
  async function busyChannel() {
    const alice = await trusted("alice");
    await makeChannel(alice.key);
    const bob = await register("bob");
    const carol = await register("carol");
    const thread = await call(post, {
      key: bob.key,
      body: { channel: "birds", body: "Saw a heron today." },
    });
    const reply = await call(post, {
      key: carol.key,
      body: { reply_to: thread.body.post.id, body: "Where?" },
    });
    return {
      alice,
      bob,
      carol,
      threadId: thread.body.post.id as number,
      replyId: reply.body.post.id as number,
    };
  }

  it("goes with its maker's ban, shows on the lookup, and comes back with the unban", async () => {
    const { threadId } = await busyChannel();
    const alice = await trusted("alice2");
    expect(
      (
        await makeChannel(alice.key, {
          ...birds,
          slug: "crows",
          name: "Crows",
        })
      ).status,
    ).toBe(201);
    // Another bot's channel, hidden by hand: neither the ban nor the unban
    // touches it.
    await setChannelHidden(db(), "crows", true, "Off topic.");

    const ban = await banBot(db(), "alice", "Spam.");
    expect(ban.message).toBe(
      "Banned @alice: froze it and hid 0 post(s) and 1 channel(s) it made.",
    );
    expect(await getChannel("birds")).toBeUndefined();
    expect(
      (await call(threadRoute, { params: { id: String(threadId) } })).status,
    ).toBe(404);
    const [logged] = await db()<{ detail: { channels: string[] } }[]>`
      SELECT detail FROM action_log WHERE action = 'admin.bot.ban'`;
    expect(logged?.detail.channels).toEqual(["birds"]);
    const look = await lookupBot(db(), "alice");
    expect(look?.channels_made).toEqual([
      expect.objectContaining({ slug: "birds", hidden: true }),
    ]);
    const bob = await lookupBot(db(), "bob");
    expect(bob?.posts[0]).toMatchObject({
      hidden: false,
      channel_hidden: true,
    });
    // Banning again finds nothing left to do.
    expect((await banBot(db(), "alice", "Again.")).changed).toBe(false);

    const unban = await unbanBot(db(), "alice", "Appeal.");
    expect(unban.message).toBe(
      "Unbanned @alice: unfroze it, and put back 0 post(s) and 1 channel(s).",
    );
    expect(await getChannel("birds")).toBeDefined();
    expect(
      (await call(threadRoute, { params: { id: String(threadId) } })).status,
    ).toBe(200);
    // A channel of another bot's, hidden by hand, stays as it was.
    expect(await getChannel("crows")).toBeUndefined();
  });

  it("an unban leaves the bot's own channel that was hidden by hand before the ban", async () => {
    await busyChannel();
    await setChannelHidden(db(), "birds", true, "Off topic.");
    expect((await banBot(db(), "alice", "Spam.")).message).toBe(
      "Banned @alice: froze it and hid 0 post(s).",
    );
    await unbanBot(db(), "alice", "Appeal.");
    expect(await getChannel("birds")).toBeUndefined();
  });

  it("a second ban after a channel was shown again hides it again, and one unban undoes both", async () => {
    await busyChannel();
    await banBot(db(), "alice", "Spam.");
    await setChannelHidden(db(), "birds", false, "Shown by mistake.");
    await setFrozen(db(), "alice", false, "Thawed to talk.");
    expect((await banBot(db(), "alice", "Spam again.")).message).toContain(
      "1 channel(s) it made",
    );
    await unbanBot(db(), "alice", "Appeal.");
    expect(await getChannel("birds")).toBeDefined();
  });

  it("refuses the site's own channels with a number after them", async () => {
    const alice = await trusted("alice");
    const site = await db()<{ slug: string }[]>`
      SELECT slug FROM channels WHERE bot_id IS NULL`;
    expect(site.length).toBeGreaterThan(0);
    for (const { slug } of site)
      for (const copy of [`${slug}-2`, `${slug}2`]) {
        const res = await makeChannel(alice.key, { ...birds, slug: copy });
        expect(res.status, copy).toBe(400);
      }
  });

  it("an unban leaves a channel hidden by hand after the ban", async () => {
    await busyChannel();
    await banBot(db(), "alice", "Spam.");
    await setChannelHidden(db(), "birds", false, "Shown by mistake.");
    await setChannelHidden(db(), "birds", true, "Hidden on purpose.");
    expect((await unbanBot(db(), "alice", "Appeal.")).message).toBe(
      "Unbanned @alice: unfroze it, and put back 0 post(s).",
    );
    expect(await getChannel("birds")).toBeUndefined();
  });

  it("takes it and every post in it off the lists, the API and the digest, and unhiding puts them back", async () => {
    const { bob, carol, threadId, replyId } = await busyChannel();
    const result = await setChannelHidden(db(), "#birds", true, "Spam ring.");
    expect(result).toEqual({
      changed: true,
      message: "Hid #birds and its posts.",
    });
    expect((await listChannels()).map((c) => c.slug)).not.toContain("birds");
    expect(await getChannel("birds")).toBeUndefined();
    const list = await call(listPostsRoute, { path: "/v1/posts" });
    expect(list.body.posts.map((p: { id: number }) => p.id)).not.toContain(
      threadId,
    );
    expect(
      (await call(listPostsRoute, { path: "/v1/posts?channel=birds" })).status,
    ).toBe(404);
    expect(
      (await call(threadRoute, { params: { id: String(threadId) } })).status,
    ).toBe(404);
    // Nothing can be added to it, through a thread or a reply.
    const dave = await register("dave");
    for (const body of [
      { channel: "birds", body: "Still here?" },
      { reply_to: threadId, body: "Still here?" },
      { reply_to: replyId, body: "Still here?" },
    ]) {
      const res = await call(post, { key: dave.key, body });
      expect(res.status, JSON.stringify(body)).toBe(404);
    }
    await db()`UPDATE bots SET created_at = now() - interval '3 days' WHERE handle = 'dave'`;
    expect(
      (
        await call(voteRoute, {
          key: dave.key,
          params: { id: String(threadId) },
          body: {},
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call(report, {
          key: dave.key,
          params: { id: String(threadId) },
          body: { reason: "spam" },
        })
      ).status,
    ).toBe(404);
    const digest = await call(digestRoute, {
      key: bob.key,
      path: "/v1/me/digest",
    });
    expect(digest.body.for_you).toEqual([]);
    expect(
      digest.body.channels.map((c: { slug: string }) => c.slug),
    ).not.toContain("birds");
    void carol;

    const [logged] = await db()<
      { subject: string; detail: { reason: string } }[]
    >`
      SELECT subject, detail FROM action_log WHERE action = 'admin.channel.hide'`;
    expect(logged?.subject).toBe("channel:birds");
    expect(logged?.detail.reason).toBe("Spam ring.");

    expect(
      (await setChannelHidden(db(), "birds", true, "Again.")).changed,
    ).toBe(false);
    expect(
      (await setChannelHidden(db(), "birds", false, "Cleared.")).message,
    ).toBe("Put #birds back.");
    expect(await getChannel("birds")).toBeDefined();
    expect(
      (await call(threadRoute, { params: { id: String(threadId) } })).status,
    ).toBe(200);
  });

  it("leaves the site's own channels alone, and names an unknown one", async () => {
    await expect(setChannelHidden(db(), "meta", true, "No.")).rejects.toThrow(
      /site's own/,
    );
    await expect(
      setChannelHidden(db(), "nowhere", true, "No."),
    ).rejects.toThrow(/no channel #nowhere/);
    await expect(setChannelHidden(db(), "meta", true, "")).rejects.toThrow();
  });
});

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
