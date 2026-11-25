import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  POST as announceRoute,
  GET as listRoute,
} from "@/app/v1/gatherings/route";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { GET as digestRoute } from "@/app/v1/me/digest/route";
import { db } from "@/lib/db";
import { databaseRefusal } from "@/lib/http";
import { call, freshIp, linkBot, register, resetDb } from "./helpers";

// A gathering may name the public channel it happens in (H1b,
// 086_gathering_channel.sql), by slug. A hidden or made-up channel gets the
// same refusal, an archived one the refusal a post there gets, and a read
// names the channel only while it's visible.

vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  connection: async () => {},
}));

beforeEach(resetDb);

type Bot = { handle: string; key: string };

let owners = 0;
async function trusted(handle: string): Promise<Bot> {
  const bot = await register(handle);
  owners += 1;
  await linkBot(bot.key, `google-c${owners}`);
  await db()`UPDATE bots SET created_at = now() - interval '3 days' WHERE handle = ${bot.handle}`;
  return bot;
}

const ahead = (minutes: number) =>
  new Date(Date.now() + minutes * 60_000).toISOString();

const announce = (b: Bot, body: unknown) =>
  call(announceRoute, { key: b.key, body });
const list = (b?: Bot) =>
  call(listRoute, { key: b?.key, path: "/v1/gatherings" });
const digest = (b: Bot) =>
  call(digestRoute, { key: b.key, path: "/v1/me/digest" });

async function channelId(slug: string): Promise<string> {
  const [c] = await db()<{ id: string }[]>`
    SELECT id FROM channels WHERE slug = ${slug}`;
  if (!c) throw new Error(`no channel ${slug}`);
  return c.id;
}

async function gatheringCount(): Promise<number> {
  const [r] = await db()<
    { n: number }[]
  >`SELECT count(*)::int AS n FROM gatherings`;
  return r?.n ?? 0;
}

async function limitRows(): Promise<number> {
  const [r] = await db()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM rate_limits WHERE bucket LIKE 'gathering%'`;
  return r?.n ?? 0;
}

describe("a gathering's channel", () => {
  it("takes a public channel's slug and names it on every read", async () => {
    const host = await trusted("host");
    const reader = await register("reader");
    const res = await announce(host, {
      title: "Bot jam",
      starts_at: ahead(60),
      channel: "research",
    });
    expect(res.status).toBe(201);
    expect(res.body.gathering.channel).toBe("research");
    const id = res.body.gathering.id;
    const [row] = await db()<{ channel_id: string }[]>`
      SELECT channel_id FROM gatherings WHERE id = ${id}`;
    expect(row?.channel_id).toBe(await channelId("research"));
    const [log] = await db()<{ detail: { channel?: string } }[]>`
      SELECT detail FROM action_log WHERE action = 'gathering.announce'`;
    expect(log?.detail.channel).toBe("research");
    const listed = (await list()).body.gatherings.find(
      (g: { id: number }) => g.id === id,
    );
    expect(listed.channel).toBe("research");
    const seen = (await digest(reader)).body.gatherings.find(
      (g: { id: number }) => g.id === id,
    );
    expect(seen.channel).toBe("research");
  });

  it("leaves channel out when none was given", async () => {
    const host = await trusted("host");
    const res = await announce(host, {
      title: "Bot jam",
      starts_at: ahead(60),
    });
    expect(res.status).toBe(201);
    expect("channel" in res.body.gathering).toBe(false);
  });

  it("refuses a hidden channel as it refuses a made-up one, writing nothing and using no quota", async () => {
    const host = await trusted("host");
    await db()`INSERT INTO hidden_channels (channel_id) VALUES (${await channelId("writing")})`;
    const hidden = await announce(host, {
      title: "Bot jam",
      starts_at: ahead(60),
      channel: "writing",
    });
    const madeUp = await announce(host, {
      title: "Bot jam",
      starts_at: ahead(60),
      channel: "no-such-place",
    });
    expect(hidden.status).toBe(404);
    expect(madeUp.status).toBe(404);
    expect(hidden.body.error.code).toBe("no_such_channel");
    expect(madeUp.body.error.code).toBe("no_such_channel");
    // The same words but for the slug the caller gave.
    expect(hidden.body.error.message.replace("writing", "X")).toBe(
      madeUp.body.error.message.replace("no-such-place", "X"),
    );
    expect(await gatheringCount()).toBe(0);
    expect(await limitRows()).toBe(0);
  });

  it("refuses an archived channel, which takes nothing new", async () => {
    const host = await trusted("host");
    await db()`UPDATE channels SET archived_at = now() WHERE slug = 'small-talk'`;
    const res = await announce(host, {
      title: "Bot jam",
      starts_at: ahead(60),
      channel: "small-talk",
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("channel_archived");
    expect(await gatheringCount()).toBe(0);
    expect(await limitRows()).toBe(0);
    // Hidden as well as archived: it answers as a made-up one.
    await db()`INSERT INTO hidden_channels (channel_id) VALUES (${await channelId("small-talk")})`;
    const both = await announce(host, {
      title: "Bot jam",
      starts_at: ahead(60),
      channel: "small-talk",
    });
    expect(both.status).toBe(404);
    expect(both.body.error.code).toBe("no_such_channel");
  });

  it("holds a gated bot back the same whatever channel it names", async () => {
    const fresh = await register("fresh");
    await db()`INSERT INTO hidden_channels (channel_id) VALUES (${await channelId("writing")})`;
    const codes = [];
    for (const channel of ["writing", "no-such-place", "research"]) {
      const res = await announce(fresh, {
        title: "Bot jam",
        starts_at: ahead(60),
        channel,
      });
      codes.push([res.status, res.body.error.code]);
    }
    expect(codes).toEqual([
      [403, "not_yet"],
      [403, "not_yet"],
      [403, "not_yet"],
    ]);
  });

  it("answers the trigger's refusals as the app's own", () => {
    expect(databaseRefusal({ code: "UPG03" })).toMatchObject({
      status: 404,
      code: "no_such_channel",
    });
    expect(databaseRefusal({ code: "UPA01" })).toMatchObject({
      status: 403,
      code: "channel_archived",
    });
  });

  it("refuses a slug that isn't one in words", async () => {
    const host = await trusted("host");
    const res = await announce(host, {
      title: "Bot jam",
      starts_at: ahead(60),
      channel: "private:5",
    });
    expect(res.status).toBe(400);
    expect(await gatheringCount()).toBe(0);
  });

  it("drops the pointer while a moderator hides the channel, and brings it back when unhidden", async () => {
    const host = await trusted("host");
    const id = (
      await announce(host, {
        title: "Bot jam",
        starts_at: ahead(60),
        channel: "research",
      })
    ).body.gathering.id;
    const research = await channelId("research");
    await db()`INSERT INTO hidden_channels (channel_id) VALUES (${research})`;
    const hidden = (await list()).body.gatherings.find(
      (g: { id: number }) => g.id === id,
    );
    expect(hidden).toBeDefined();
    expect("channel" in hidden).toBe(false);
    const reader = await register("reader");
    const seen = (await digest(reader)).body.gatherings.find(
      (g: { id: number }) => g.id === id,
    );
    expect(seen).toBeDefined();
    expect("channel" in seen).toBe(false);
    await db()`DELETE FROM hidden_channels WHERE channel_id = ${research}`;
    const back = (await list()).body.gatherings.find(
      (g: { id: number }) => g.id === id,
    );
    expect(back.channel).toBe("research");
  });

  it("is backed by the database: a hidden, archived or missing channel can't be written", async () => {
    const host = await trusted("host");
    const [k] = await db()<{ bot: string; key: string }[]>`
      SELECT b.id AS bot, k.id AS key FROM bots b JOIN api_keys k ON k.bot_id = b.id
      WHERE b.handle = ${host.handle} AND k.revoked_at IS NULL`;
    const insert = (channel: string) => db()`
      INSERT INTO gatherings (bot_id, key_id, title, starts_at, channel_id)
      VALUES (${k?.bot ?? null}, ${k?.key ?? null}, 'Jam', now() + interval '1 hour', ${channel})`;
    const writing = await channelId("writing");
    await db()`INSERT INTO hidden_channels (channel_id) VALUES (${writing})`;
    await expect(insert(writing)).rejects.toMatchObject({ code: "UPG03" });
    await db()`UPDATE channels SET archived_at = now() WHERE slug = 'small-talk'`;
    await expect(insert(await channelId("small-talk"))).rejects.toMatchObject({
      code: "UPA01",
    });
    await expect(insert("999999")).rejects.toMatchObject({ code: "UPG03" });
    expect(await gatheringCount()).toBe(0);
    // And a channel id never changes once written.
    await insert(await channelId("research"));
    await expect(
      db()`UPDATE gatherings SET channel_id = ${writing}`,
    ).rejects.toBeDefined();
  });

  it("goes through set_event's announce by slug, and takes only a private channel elsewhere", async () => {
    const host = await trusted("host");
    let id = 0;
    async function tool(args: object) {
      id += 1;
      const req = new Request("http://unprompted.test/v1/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "x-real-ip": freshIp(),
          host: "unprompted.test",
          authorization: `Bearer ${host.key}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: "set_event", arguments: args },
        }),
      });
      const result = (await (await mcpRoute(req, undefined as never)).json())
        .result;
      const text = (result?.content?.[0]?.text ?? "") as string;
      let data: unknown = text;
      try {
        data = JSON.parse(text);
      } catch {}
      return { isError: result?.isError === true, data, text };
    }
    const ok = await tool({
      action: "announce",
      title: "Bot jam",
      starts_at: ahead(90),
      channel: "research",
    });
    expect(ok.isError).toBe(false);
    expect(
      (ok.data as { gathering: { channel: string } }).gathering.channel,
    ).toBe("research");
    const priv = await tool({
      action: "announce",
      title: "Bot jam",
      starts_at: ahead(90),
      channel: "private:3",
    });
    expect(priv.isError).toBe(true);
    await db()`INSERT INTO hidden_channels (channel_id) VALUES (${await channelId("writing")})`;
    const answers = [];
    for (const channel of ["writing", "no-such-place"]) {
      const r = await tool({
        action: "announce",
        title: "Bot jam",
        starts_at: ahead(90),
        channel,
      });
      expect(r.isError).toBe(true);
      answers.push(r.text.replace(channel, "X"));
    }
    expect(answers[0]).toBe(answers[1]);
    expect(answers[0]).toContain("no_such_channel");
    expect(priv.text).toContain("public channel");
    const slugForSession = await tool({
      action: "session",
      channel: "research",
      in_minutes: 30,
    });
    expect(slugForSession.isError).toBe(true);
    expect(slugForSession.text).toContain("private:<id>");
    expect(await gatheringCount()).toBe(1);
  });
});

describe("the others in what's new", () => {
  it("puts ones still to start ahead of running ones, so a day of running ones can't crowd them out", async () => {
    const host = await trusted("host");
    const reader = await register("reader");
    const [k] = await db()<{ bot: string; key: string }[]>`
      SELECT b.id AS bot, k.id AS key FROM bots b JOIN api_keys k ON k.bot_id = b.id
      WHERE b.handle = ${host.handle} AND k.revoked_at IS NULL`;
    const running: number[] = [];
    for (let i = 0; i < 3; i++) {
      const [g] = await db()<{ id: string }[]>`
        INSERT INTO gatherings (bot_id, key_id, title, starts_at, lasts_minutes, created_at)
        VALUES (${k?.bot ?? null}, ${k?.key ?? null}, 'All day',
                now() - make_interval(mins => ${120 + i}), 1440, now() - interval '1 day')
        RETURNING id`;
      running.push(Number(g?.id));
    }
    const soon = (
      await announce(host, { title: "Starting soon", starts_at: ahead(60) })
    ).body.gathering.id;
    const others = (await digest(reader)).body.gatherings as {
      id: number;
      state: string;
    }[];
    expect(others[0]?.id).toBe(soon);
    expect(others.slice(1).every((g) => g.state === "running")).toBe(true);
  });
});
