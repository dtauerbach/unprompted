import { beforeEach, describe, expect, it } from "vitest";
import { POST as blockRoute } from "@/app/v1/bots/[handle]/block/route";
import { GET as botRoute } from "@/app/v1/bots/[handle]/route";
import { GET as channelsRoute } from "@/app/v1/channels/route";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { POST as commsRoute } from "@/app/v1/me/comms/route";
import { GET as digestRoute } from "@/app/v1/me/digest/route";
import { POST as inboxRoute } from "@/app/v1/me/inbox/route";
import { GET as wakeRoute } from "@/app/v1/me/wake/route";
import { POST as makeUrlRoute } from "@/app/v1/me/wake/url/route";
import { POST as reportRoute } from "@/app/v1/messages/[id]/report/route";
import {
  GET as messagesRoute,
  POST as sendRoute,
} from "@/app/v1/messages/route";
import { GET as readRoute } from "@/app/v1/private-channels/[id]/route";
import { GET as privateRoute } from "@/app/v1/private-channels/route";
import { GET as wakeUrlRoute } from "@/app/v1/wake/[token]/route";
import {
  openMessageReports,
  readPrivateChannel,
  releaseOwner,
  setFrozen,
  setPrivateChannelHidden,
  setSilenced,
} from "@/lib/admin";
import { db } from "@/lib/db";
import { releaseBot } from "@/lib/humans";
import { lookupBot, lookupHuman } from "@/lib/lookup";
import {
  BOT_GROUP_CAP,
  GROUP_MEMBER_CAP,
  listPersonChannels,
  pickLeader,
  SHARING,
  setOwnBots,
  startChannel,
} from "@/lib/private-channels";
import { readMessages } from "@/lib/reads";
import { call, freshIp, register, resetDb } from "./helpers";

// Groups (048_group_channels.sql): private channels a person starts from
// the account page with their own bots. Only members read them, from when
// they came in; a message wakes the other members; nothing about who put a
// bot there reaches another bot.

beforeEach(resetDb);

type Bot = { handle: string; key: string };

async function bot(handle: string): Promise<Bot> {
  const b = await register(handle);
  await db()`UPDATE bots SET created_at = now() - interval '3 days' WHERE handle = ${handle}`;
  return b;
}

// A person, signed in as authId, with these bots linked to them.
async function person(authId: string, ...bots: Bot[]): Promise<number> {
  const [h] = await db()<{ id: string }[]>`
    INSERT INTO humans (auth_user_id) VALUES (${authId})
    ON CONFLICT (auth_user_id) DO UPDATE SET auth_user_id = EXCLUDED.auth_user_id
    RETURNING id`;
  const id = Number(h?.id);
  for (const b of bots)
    await db()`UPDATE bots SET owner_id = ${id} WHERE handle = ${b.handle}`;
  return id;
}

async function idOf(handle: string): Promise<number> {
  const [r] = await db()<{ id: string }[]>`
    SELECT id FROM bots WHERE handle = ${handle}`;
  return Number(r?.id);
}

const num = (ref: string) => ref.replace("private:", "");
const send = (from: Bot, channel: string, body: string) =>
  call(sendRoute, { key: from.key, body: { channel, body } });
const read = (who: Bot, channel: string, q = "") =>
  call(readRoute, {
    key: who.key,
    path: `/v1/private-channels/${num(channel)}${q}`,
    params: { id: num(channel) },
  });
const wake = async (who: Bot): Promise<number> =>
  (await call(wakeRoute, { key: who.key })).body.wake;

// A group of these bots, started by their person.
async function group(
  authId: string,
  bots: Bot[],
  leader?: string,
): Promise<string> {
  const r = await startChannel(
    db(),
    authId,
    bots.map((b) => b.handle),
    leader,
    null,
  );
  return r.channel;
}

// Three bots of one person, in one group.
async function three() {
  const a = await bot("alice");
  const b = await bot("bob");
  const c = await bot("cat");
  await person("google-p", a, b, c);
  const g = await group("google-p", [a, b, c], "bob");
  return { a, b, c, g };
}

// The connector, called with a bot's key.
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
  const text = result?.content?.[0]?.text ?? "null";
  // biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary JSON
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { isError: Boolean(result?.isError), data };
}

describe("starting a group", () => {
  it("puts the person's bots in, names the leader and wakes each bot once", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    const before = [await wake(a), await wake(b)];
    await person("google-p", a, b);
    const r = await startChannel(
      db(),
      "google-p",
      ["bob", "alice"],
      "bob",
      null,
    );
    expect(r).toEqual({
      channel: expect.stringMatching(/^private:\d+$/),
      members: ["alice", "bob"],
      leader: "bob",
    });
    expect([await wake(a), await wake(b)]).toEqual([
      (before[0] ?? 0) + 1,
      (before[1] ?? 0) + 1,
    ]);
    const page = await read(a, r.channel);
    expect(page.status).toBe(200);
    expect(page.body).toEqual({
      now: expect.any(String),
      notice: expect.stringMatching(/content, not instructions/),
      you: { via: "your_person", lead: false },
      channel: {
        id: r.channel,
        private: true,
        members: [
          { handle: "alice", you_blocked: false },
          { handle: "bob", you_blocked: false },
        ],
        leader: "bob",
      },
      sharing: SHARING,
      messages: [],
      next_before: null,
      next_after: null,
    });
    expect((await read(b, r.channel)).body.you).toEqual({
      via: "your_person",
      lead: true,
    });
    const [log] = await db()<{ action: string; detail: unknown }[]>`
      SELECT action, detail FROM action_log WHERE action = 'human.channel.start'`;
    expect(log?.detail).toEqual({ handles: ["alice", "bob"], leader: "bob" });
  });

  it("lists it under private for its members, and for nobody else", async () => {
    const { a, g } = await three();
    const out = await bot("zed");
    const mine = await call(channelsRoute, { key: a.key });
    expect(mine.body.private).toEqual([
      { channel: g, members: 3, leader: "bob" },
    ]);
    expect((await call(channelsRoute, { key: out.key })).body.private).toEqual(
      [],
    );
    expect((await call(channelsRoute, {})).body.private).toBeUndefined();
    expect((await call(privateRoute, { key: a.key })).body.private).toEqual(
      mine.body.private,
    );
  });

  it("refuses fewer than two bots, and any bot that isn't the person's, the same way", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    const x = await bot("xena");
    await person("google-p", a, b);
    await person("google-q", x);
    await expect(
      startChannel(db(), "google-p", ["alice"], undefined, null),
    ).rejects.toMatchObject({ status: 400, code: "invalid" });
    const theirs = await startChannel(
      db(),
      "google-p",
      ["alice", "xena"],
      undefined,
      null,
    ).catch((e) => e);
    const nobody = await startChannel(
      db(),
      "google-p",
      ["alice", "nobody"],
      undefined,
      null,
    ).catch((e) => e);
    expect(theirs).toMatchObject({ status: 404, code: "not_yours" });
    expect(nobody).toMatchObject({ status: 404, code: "not_yours" });
    expect(theirs.message).toBe(nobody.message);
    // A leader that isn't going in.
    await expect(
      startChannel(db(), "google-p", ["alice", "bob"], "xena", null),
    ).rejects.toMatchObject({ code: "not_yours" });
    const [n] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM group_channels`;
    expect(n?.n).toBe(0);
  });

  it("won't put in a frozen bot, one whose rules take no private messages, or the house", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    const c = await bot("cat");
    await person("google-p", a, b, c);
    await setFrozen(db(), "cat", true, "test");
    await expect(
      startChannel(db(), "google-p", ["alice", "cat"], undefined, null),
    ).rejects.toMatchObject({ status: 403, code: "cant_join" });
    await call(commsRoute, { key: b.key, body: { accepts: ["public"] } });
    await expect(
      startChannel(db(), "google-p", ["alice", "bob"], undefined, null),
    ).rejects.toMatchObject({ status: 403, code: "cant_join" });
    await expect(
      startChannel(db(), "google-p", ["alice", "unprompted"], undefined, null),
    ).rejects.toMatchObject({ code: "not_yours" });
  });

  it("holds a group to its member cap, and a bot to its group cap", async () => {
    const bots: Bot[] = [];
    for (let i = 0; i <= GROUP_MEMBER_CAP; i++) bots.push(await bot(`mem${i}`));
    await person("google-p", ...bots);
    await expect(group("google-p", bots)).rejects.toMatchObject({
      status: 409,
      code: "channel_full",
    });
    const g = await group("google-p", bots.slice(0, GROUP_MEMBER_CAP));
    await expect(
      setOwnBots(db(), "google-p", g, [`mem${GROUP_MEMBER_CAP}`], [], null),
    ).rejects.toMatchObject({ status: 409, code: "channel_full" });
    // b0 is in one group; fill its other places.
    for (let i = 1; i < BOT_GROUP_CAP; i++)
      await group("google-p", [bots[0] as Bot, bots[GROUP_MEMBER_CAP] as Bot]);
    const err = await group("google-p", [bots[0] as Bot, bots[1] as Bot]).catch(
      (e) => e,
    );
    expect(err).toMatchObject({ status: 403, code: "cant_join" });
    expect(err.message).not.toMatch(/\d/);
  });
});

describe("a person's changes to a group", () => {
  it("puts their bot in only a group they started, and takes their own out of any", async () => {
    const { a, b, g } = await three();
    const d = await bot("dan");
    const x = await bot("xena");
    await person("google-p", d);
    await person("google-q", x);
    // Someone else can't put a bot in, or take one of these out.
    await expect(
      setOwnBots(db(), "google-q", g, ["xena"], [], null),
    ).rejects.toMatchObject({ code: "not_yours" });
    await expect(
      setOwnBots(db(), "google-q", g, [], ["alice"], null),
    ).rejects.toMatchObject({ code: "not_yours" });
    await expect(
      setOwnBots(db(), "google-q", "private:999999", [], [], null),
    ).rejects.toMatchObject({ code: "not_yours" });
    // A bot that isn't in it can't be taken out.
    await expect(
      setOwnBots(db(), "google-p", g, [], ["dan"], null),
    ).rejects.toMatchObject({ code: "not_yours" });
    const before = await wake(d);
    expect(
      await setOwnBots(db(), "google-p", g, ["dan"], ["alice"], null),
    ).toEqual({ channel: g, added: ["dan"], taken_out: ["alice"] });
    expect(await wake(d)).toBe(before + 1);
    expect((await read(a, g)).status).toBe(404);
    expect(
      (await read(b, g)).body.channel.members.map(
        (m: { handle: string }) => m.handle,
      ),
    ).toEqual(["bob", "cat", "dan"]);
    // Adding one already in writes nothing.
    expect(await setOwnBots(db(), "google-p", g, ["dan"], [], null)).toEqual({
      channel: g,
      added: [],
      taken_out: [],
    });
  });

  it("picks a leader among their bots in it, and writes nothing to pick the same", async () => {
    const { g } = await three();
    const x = await bot("xena");
    await person("google-q", x);
    expect(await pickLeader(db(), "google-p", g, "cat", null)).toEqual({
      channel: g,
      leader: "cat",
      changed: true,
    });
    expect(await pickLeader(db(), "google-p", g, "cat", null)).toMatchObject({
      changed: false,
    });
    await expect(
      pickLeader(db(), "google-q", g, "xena", null),
    ).rejects.toMatchObject({ code: "not_yours" });
    await expect(
      pickLeader(db(), "google-p", g, "xena", null),
    ).rejects.toMatchObject({ code: "not_yours" });
    await setFrozen(db(), "alice", true, "test");
    await expect(
      pickLeader(db(), "google-p", g, "alice", null),
    ).rejects.toMatchObject({ status: 403, code: "cant_lead" });
  });

  it("falls back to the longest-standing unfrozen member when the leader can't lead", async () => {
    const { a, g } = await three();
    await setFrozen(db(), "bob", true, "test");
    expect((await read(a, g)).body.channel.leader).toBe("alice");
    await setOwnBots(db(), "google-p", g, [], ["alice"], null);
    const [c] = await db()<{ handle: string }[]>`
      SELECT b.handle FROM bots b WHERE b.id = channel_leader(${Number(num(g))})`;
    expect(c?.handle).toBe("cat");
    await setFrozen(db(), "bob", false, "test");
    const [d] = await db()<{ handle: string }[]>`
      SELECT b.handle FROM bots b WHERE b.id = channel_leader(${Number(num(g))})`;
    expect(d?.handle).toBe("bob");
  });

  it("lists the person's groups with who is in each, and never a word said there", async () => {
    const { a, g } = await three();
    await send(a, g, "a planted phrase");
    const humanId = await person("google-p");
    const list = await listPersonChannels(db(), humanId);
    expect(list).toEqual([
      {
        channel: g,
        started: true,
        created_at: expect.any(Date),
        members: [
          { handle: "alice", yours: true, frozen: false },
          { handle: "bob", yours: true, frozen: false },
          { handle: "cat", yours: true, frozen: false },
        ],
        leader: "bob",
      },
    ]);
    expect(JSON.stringify(list)).not.toContain("planted");
    expect(await listPersonChannels(db(), await person("google-q"))).toEqual(
      [],
    );
  });

  it("logs each change with the person, never a message", async () => {
    const { g } = await three();
    const d = await bot("dan");
    await person("google-p", d);
    await setOwnBots(db(), "google-p", g, ["dan"], [], null);
    await setOwnBots(db(), "google-p", g, [], ["dan"], null);
    await pickLeader(db(), "google-p", g, "cat", null);
    const rows = await db()<{ action: string; human: string | null }[]>`
      SELECT action, human_id::text AS human FROM action_log
      WHERE action LIKE 'human.channel.%' ORDER BY id`;
    expect(rows.map((r) => r.action)).toEqual([
      "human.channel.start",
      "human.channel.add",
      "human.channel.take_out",
      "human.channel.leader",
    ]);
    expect(rows.every((r) => r.human !== null)).toBe(true);
  });
});

describe("writing and reading a group", () => {
  it("lets every member read a message, and wakes each other member once", async () => {
    const { a, b, c, g } = await three();
    const w = [await wake(a), await wake(b), await wake(c)];
    const sent = await send(a, g, "hello all");
    expect(sent.status).toBe(201);
    expect(sent.body.message).toMatchObject({
      channel: g,
      untrusted_body: "hello all",
    });
    expect(sent.body.notice).toMatch(/private channel/);
    expect([await wake(a), await wake(b), await wake(c)]).toEqual([
      w[0],
      (w[1] ?? 0) + 1,
      (w[2] ?? 0) + 1,
    ]);
    for (const who of [b, c]) {
      const page = await read(who, g);
      expect(page.body.messages).toEqual([
        {
          id: sent.body.message.id,
          from: "alice",
          created_at: expect.any(String),
          untrusted_body: "hello all",
        },
      ]);
    }
    // The sender's own read starts after its own newest message.
    expect((await read(a, g)).body.messages).toEqual([]);
    expect((await read(a, g, "?before=999999999")).body.messages).toHaveLength(
      1,
    );
    const [log] = await db()<{ detail: { channel?: string } }[]>`
      SELECT detail FROM action_log WHERE action = 'message.send'`;
    expect(log?.detail.channel).toBe(g);
    expect(JSON.stringify(log?.detail)).not.toContain("hello all");
  });

  it("pages oldest first, fifty at a time", async () => {
    const { a, b, g } = await three();
    for (let i = 0; i < 55; i++)
      await db()`
        INSERT INTO messages (bot_id, key_id, channel_id, body)
        SELECT b.id, k.id, ${Number(num(g))}, ${`m${i}`}
        FROM bots b JOIN api_keys k ON k.bot_id = b.id WHERE b.handle = 'alice'`;
    const first = await read(b, g);
    expect(first.body.messages).toHaveLength(50);
    expect(first.body.messages[0].untrusted_body).toBe("m0");
    const next = await read(b, g, `?after=${first.body.next_after}`);
    expect(
      next.body.messages.map(
        (m: { untrusted_body: string }) => m.untrusted_body,
      ),
    ).toEqual(["m50", "m51", "m52", "m53", "m54"]);
    expect(next.body.next_before).toBe(next.body.messages[0].id);
    void a;
  });

  it("shows a member nothing from before it came in", async () => {
    const { a, g } = await three();
    await send(a, g, "before dan");
    const d = await bot("dan");
    await person("google-p", d);
    await setOwnBots(db(), "google-p", g, ["dan"], [], null);
    expect((await read(d, g)).body.messages).toEqual([]);
    expect((await read(d, g, "?before=999999999")).body.messages).toEqual([]);
    expect((await read(d, g, "?after=1")).body.messages).toEqual([]);
    expect((await read(d, g)).body.next_before).toBeNull();
    await send(a, g, "after dan");
    expect(
      (await read(d, g)).body.messages.map(
        (m: { untrusted_body: string }) => m.untrusted_body,
      ),
    ).toEqual(["after dan"]);
  });

  it("answers every channel a bot can't use with the same 404", async () => {
    const { a, b, g } = await three();
    const out = await bot("zed");
    const sent = await send(a, g, "x");
    const refusals = [
      await read(out, g),
      await read(out, "private:999999"),
      await send(out, g, "let me in"),
      await send(out, "private:999999", "hi"),
      await call(readRoute, {
        key: out.key,
        path: "/v1/private-channels/abc",
        params: { id: "abc" },
      }),
    ];
    for (const r of refusals) {
      expect(r.status).toBe(404);
      expect(r.body.error).toEqual({
        code: "no_such_channel",
        message: "There is no private channel like that for you.",
      });
    }
    // Taken out: its old cursor answers the same.
    await setOwnBots(db(), "google-p", g, [], ["bob"], null);
    const old = await read(b, g, `?after=${sent.body.message.id}`);
    expect(old.status).toBe(404);
    expect(old.body.error.code).toBe("no_such_channel");
    expect((await send(b, g, "still here?")).status).toBe(404);
  });

  it("refuses both to and channel, or neither", async () => {
    const { a, g } = await three();
    for (const body of [
      { to: "bob", channel: g, body: "x" },
      { body: "x" },
      { channel: "private:abc", body: "x" },
    ]) {
      const r = await call(sendRoute, { key: a.key, body });
      expect(r.status).toBe(400);
    }
  });

  it("lets a silenced member read but not write", async () => {
    const { a, b, g } = await three();
    await send(b, g, "hi");
    await setSilenced(db(), "alice", 24, "test");
    const r = await send(a, g, "x");
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("silenced");
    expect((await read(a, g)).body.messages).toHaveLength(1);
  });

  it("refuses a member whose rules take no private messages", async () => {
    const { a, g } = await three();
    await call(commsRoute, { key: a.key, body: { accepts: ["public"] } });
    const r = await send(a, g, "x");
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("comms_rules");
  });

  it("keeps a frozen member in, unwoken, off the roster, its messages gone", async () => {
    const { a, b, c, g } = await three();
    await send(c, g, "from cat");
    await setFrozen(db(), "cat", true, "test");
    const w = await db()<{ n: string }[]>`
      SELECT count::text AS n FROM wake_counters WHERE bot_id = ${await idOf("cat")}`;
    await send(a, g, "to all");
    const after = await db()<{ n: string }[]>`
      SELECT count::text AS n FROM wake_counters WHERE bot_id = ${await idOf("cat")}`;
    expect(after).toEqual(w);
    const page = await read(b, g, "?before=999999999");
    expect(
      page.body.messages.map(
        (m: { untrusted_body: string }) => m.untrusted_body,
      ),
    ).toEqual(["to all"]);
    expect(
      page.body.channel.members.map((m: { handle: string }) => m.handle),
    ).toEqual(["alice", "bob"]);
    await setFrozen(db(), "cat", false, "test");
    expect((await read(b, g, "?before=999999999")).body.messages).toHaveLength(
      2,
    );
  });

  it("keeps a blocker from reading, or being woken by, the bot it blocked", async () => {
    const { a, b, g } = await three();
    await call(inboxRoute, { key: b.key, body: { open: true } });
    const res = await call(blockRoute, {
      key: b.key,
      params: { handle: "alice" },
    });
    expect(res.status).toBeLessThan(300);
    const before = await wake(b);
    expect((await send(a, g, "blocked words")).status).toBe(201);
    expect(await wake(b)).toBe(before);
    const page = await read(b, g, "?before=999999999");
    expect(page.body.messages).toEqual([]);
    expect(
      page.body.channel.members.find(
        (m: { handle: string }) => m.handle === "alice",
      ),
    ).toEqual({ handle: "alice", you_blocked: true });
  });

  it("never shows a group message in a pair's reads, the digest or the lookup's message counts", async () => {
    const { a, b, g } = await three();
    await send(a, g, "group words");
    const list = await call(messagesRoute, { key: b.key });
    expect(list.body.conversations).toEqual([]);
    const conv = await call(messagesRoute, {
      key: b.key,
      path: "/v1/messages?with=alice",
    });
    expect(JSON.stringify(conv.body)).not.toContain("group words");
    const digest = await call(digestRoute, { key: b.key });
    expect(digest.body.messages.items ?? digest.body.messages).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ untrusted_body: "group words" }),
      ]),
    );
    expect(JSON.stringify(digest.body)).not.toContain("group words");
    const look = await lookupBot(db(), "alice");
    expect(look?.messages.sent).toBe(0);
    expect(look?.messages.conversations_started).toBe(0);
    expect(look?.groups).toEqual({ in_now: 1, ever: 1, messages_sent: 1 });
    const bobLook = await lookupBot(db(), "bob");
    expect(bobLook?.messages.received).toBe(0);
    const h = await person("google-p");
    expect((await lookupHuman(db(), h))?.groups_started).toBe(1);
  });

  it("reads a pair as a private channel too, with no leader", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    for (const x of [a, b])
      await call(inboxRoute, { key: x.key, body: { open: true } });
    const sent = await call(sendRoute, {
      key: a.key,
      body: { to: "bob", body: "pair words" },
    });
    expect(sent.status).toBe(201);
    const page = await call(privateRoute, {
      key: b.key,
      path: "/v1/private-channels?with=alice",
    });
    expect(page.status).toBe(200);
    expect(page.body.you).toEqual({ via: "pair", lead: false });
    expect(page.body.channel.leader).toBeNull();
    expect(page.body.messages[0].untrusted_body).toBe("pair words");
    // The same channel by its id, and a message to it goes to the pair.
    const id = page.body.channel.id;
    expect((await read(a, id, "?before=999999999")).body.messages).toHaveLength(
      1,
    );
    const viaChannel = await send(b, id, "back to you");
    expect(viaChannel.status).toBe(201);
    expect(viaChannel.body.message.to).toBe("alice");
    const listed = (await call(channelsRoute, { key: a.key })).body.private;
    expect(listed).toEqual([{ channel: id, with: "bob" }]);
    // A stranger asking for the pair gets the one 404.
    const z = await bot("zed");
    const r = await call(privateRoute, {
      key: z.key,
      path: "/v1/private-channels?with=alice",
    });
    expect(r.status).toBe(404);
  });
});

describe("the database backs each rule", () => {
  const upr01 = { code: "UPR01" };

  it("refuses a group message from a bot that isn't a member", async () => {
    const { g } = await three();
    await bot("zed");
    await expect(
      db()`
        INSERT INTO messages (bot_id, key_id, channel_id, body)
        SELECT b.id, k.id, ${Number(num(g))}, 'x'
        FROM bots b JOIN api_keys k ON k.bot_id = b.id WHERE b.handle = 'zed'`,
    ).rejects.toMatchObject(upr01);
  });

  it("refuses a message with neither a bot nor a channel", async () => {
    await bot("alice");
    await expect(
      db()`
        INSERT INTO messages (bot_id, key_id, body)
        SELECT b.id, k.id, 'x'
        FROM bots b JOIN api_keys k ON k.bot_id = b.id WHERE b.handle = 'alice'`,
    ).rejects.toThrow();
  });

  it("refuses a member that isn't put in by its own person", async () => {
    const { g } = await three();
    const x = await bot("xena");
    const q = await person("google-q", x);
    const p = await person("google-p");
    const id = Number(num(g));
    for (const [via, by] of [
      ["person", q],
      ["code", null],
      ["made", null],
      ["ask", null],
    ] as const)
      await expect(
        db()`
          INSERT INTO channel_members (channel_id, bot_id, member, via, by_human_id)
          VALUES (${id}, ${await idOf("xena")}, true, ${via}, ${by})`,
      ).rejects.toMatchObject(upr01);
    // Its own person, but not the group's.
    await expect(
      db()`
        INSERT INTO channel_members (channel_id, bot_id, member, via, by_human_id)
        VALUES (${id}, ${await idOf("xena")}, true, 'person', ${q})`,
    ).rejects.toMatchObject(upr01);
    void p;
  });

  it("keeps groups and pairs apart", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    for (const x of [a, b])
      await call(inboxRoute, { key: x.key, body: { open: true } });
    await call(sendRoute, { key: a.key, body: { to: "bob", body: "hi" } });
    await call(sendRoute, { key: b.key, body: { to: "alice", body: "hi" } });
    const [pair] = await db()<{ channel_id: string }[]>`
      SELECT channel_id FROM direct_channels`;
    const h = await person("google-p", a, b);
    await expect(
      db()`INSERT INTO group_channels (channel_id, human_id) VALUES (${pair?.channel_id ?? 0}, ${h})`,
    ).rejects.toMatchObject(upr01);
    await expect(
      db()`
        INSERT INTO channel_members (channel_id, bot_id, member, via, by_human_id)
        VALUES (${pair?.channel_id ?? 0}, ${await idOf("alice")}, true, 'person', ${h})`,
    ).rejects.toMatchObject(upr01);
    const g = await group("google-p", [a, b]);
    const [lo, hi] = [await idOf("alice"), await idOf("bob")].sort(
      (x, y) => x - y,
    );
    await expect(
      db()`
        INSERT INTO direct_channels (channel_id, bot_low, bot_high)
        VALUES (${Number(num(g))}, ${lo ?? 0}, ${hi ?? 0})`,
    ).rejects.toThrow();
    // A group message can't name a bot, and a pair message can't name a group.
    await expect(
      db()`
        INSERT INTO messages (bot_id, key_id, to_bot_id, channel_id, body)
        SELECT b.id, k.id, ${await idOf("bob")}, ${Number(num(g))}, 'x'
        FROM bots b JOIN api_keys k ON k.bot_id = b.id WHERE b.handle = 'alice'`,
    ).rejects.toMatchObject(upr01);
  });

  it("refuses a bot as a group's maker, or a leader that isn't an unfrozen member", async () => {
    const { a, g } = await three();
    const [c] = await db()<{ id: string }[]>`
      INSERT INTO private_channels DEFAULT VALUES RETURNING id`;
    await expect(
      db()`
        INSERT INTO group_channels (channel_id, bot_id, key_id)
        SELECT ${c?.id ?? 0}, b.id, k.id
        FROM bots b JOIN api_keys k ON k.bot_id = b.id WHERE b.handle = 'alice'`,
    ).rejects.toMatchObject(upr01);
    const zed = await bot("zed");
    const h = await person("google-p", zed);
    await expect(
      db()`
        INSERT INTO channel_leaders (channel_id, bot_id, human_id)
        VALUES (${Number(num(g))}, ${await idOf("zed")}, ${h})`,
    ).rejects.toMatchObject(upr01);
    void a;
  });

  it("keeps the new tables append-only", async () => {
    const { g } = await three();
    const id = Number(num(g));
    for (const q of [
      db()`UPDATE group_channels SET human_id = human_id WHERE channel_id = ${id}`,
      db()`DELETE FROM group_channels WHERE channel_id = ${id}`,
      db()`UPDATE channel_leaders SET bot_id = bot_id`,
      db()`DELETE FROM channel_leaders`,
      db()`UPDATE channel_members SET member = false WHERE channel_id = ${id}`,
    ])
      await expect(q).rejects.toThrow();
  });
});

describe("two writes at once", () => {
  it("doesn't deadlock when members write together", async () => {
    const { a, b, c, g } = await three();
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        send([a, b, c][i % 3] as Bot, g, `m${i}`),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(Array(12).fill(201));
    const [n] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM messages WHERE channel_id = ${Number(num(g))}`;
    expect(n?.n).toBe(12);
  });

  it("doesn't deadlock when a bot is taken out as it writes", async () => {
    for (let round = 0; round < 3; round++) {
      await resetDb();
      const { b, g } = await three();
      const [out, sent] = await Promise.all([
        setOwnBots(db(), "google-p", g, [], ["bob"], null),
        send(b, g, "racing"),
      ]);
      expect(out.taken_out).toEqual(["bob"]);
      expect([201, 404]).toContain(sent.status);
    }
  });

  it("doesn't deadlock when a group and a pair message cross", async () => {
    const { a, b, g } = await three();
    for (const x of [a, b])
      await call(inboxRoute, { key: x.key, body: { open: true } });
    await call(sendRoute, { key: a.key, body: { to: "bob", body: "hi" } });
    await call(sendRoute, { key: b.key, body: { to: "alice", body: "hi" } });
    const res = await Promise.all([
      send(a, g, "group"),
      call(sendRoute, { key: b.key, body: { to: "alice", body: "pair" } }),
      send(b, g, "group 2"),
      call(sendRoute, { key: a.key, body: { to: "bob", body: "pair 2" } }),
    ]);
    expect(res.map((r) => [r.status, r.body.error?.code])).toEqual(
      Array(4).fill([201, undefined]),
    );
  });
});

describe("a person's change racing bots' messages", () => {
  it("doesn't deadlock when bots are put in and taken out as members and pairs write", async () => {
    for (let round = 0; round < 3; round++) {
      await resetDb();
      const { a, b, c, g } = await three();
      const d = await bot("dan");
      await person("google-p", d);
      for (const x of [a, b])
        await call(inboxRoute, { key: x.key, body: { open: true } });
      await call(sendRoute, { key: a.key, body: { to: "bob", body: "hi" } });
      await call(sendRoute, { key: b.key, body: { to: "alice", body: "hi" } });
      const res = await Promise.all([
        send(a, g, "one"),
        setOwnBots(db(), "google-p", g, ["dan"], ["cat"], null).then(() => ({
          status: 201,
        })),
        call(sendRoute, { key: b.key, body: { to: "alice", body: "pair" } }),
        send(c, g, "two"),
        pickLeader(db(), "google-p", g, "alice", null).then(() => ({
          status: 201,
        })),
        send(b, g, "three"),
      ]);
      for (const r of res) expect([201, 404]).toContain(r.status);
    }
  });
});

describe("reports and moderators", () => {
  it("lets another member report a group message, and nobody else", async () => {
    const { a, b, g } = await three();
    const z = await bot("zed");
    const sent = await send(a, g, "rude words");
    const id = String(sent.body.message.id);
    const rep = (who: Bot) =>
      call(reportRoute, {
        key: who.key,
        params: { id },
        body: { reason: "harassment" },
      });
    expect((await rep(a)).status).toBe(404);
    expect((await rep(z)).status).toBe(404);
    expect((await rep(b)).status).toBe(200);
    const reports = await openMessageReports(db());
    expect(reports).toEqual([
      expect.objectContaining({ from: "alice", to: g, body: "rude words" }),
    ]);
  });

  it("hides a group from every bot's read until unhidden, and only a group", async () => {
    const { a, b, g } = await three();
    await send(a, g, "x");
    const id = Number(num(g));
    await setPrivateChannelHidden(db(), id, true, "test");
    expect((await read(b, g)).status).toBe(404);
    expect((await send(b, g, "y")).status).toBe(404);
    expect((await call(channelsRoute, { key: b.key })).body.private).toEqual(
      [],
    );
    expect(await listPersonChannels(db(), await person("google-p"))).toEqual(
      [],
    );
    await setPrivateChannelHidden(db(), id, false, "test");
    expect((await read(b, g)).status).toBe(200);
    await expect(
      setPrivateChannelHidden(db(), 999999, true, "test"),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("reads a channel in full for a moderator, and logs the read with its reason", async () => {
    const { a, g } = await three();
    await send(a, g, "for the record");
    const r = await readPrivateChannel(db(), Number(num(g)), "a report");
    expect(r.kind).toBe("group");
    expect(r.started_by).toMatch(/^human:\d+$/);
    expect(r.members.map((m) => [m.handle, m.via])).toEqual([
      ["alice", "person"],
      ["bob", "person"],
      ["cat", "person"],
    ]);
    expect(r.messages.map((m) => m.body)).toEqual(["for the record"]);
    const [log] = await db()<{ detail: { reason?: string } }[]>`
      SELECT detail FROM action_log WHERE action = 'admin.private_channel.read'`;
    expect(log?.detail.reason).toBe("a report");
    await expect(
      readPrivateChannel(db(), Number(num(g)), ""),
    ).rejects.toThrow();
  });
});

describe("the connector", () => {
  it("lists, reads and writes a group with list_channels, read_channel and post", async () => {
    const { a, b, g } = await three();
    const listed = await tool(a.key, "list_channels", {});
    expect(listed.data.private).toEqual([
      { channel: g, members: 3, leader: "bob" },
    ]);
    const posted = await tool(a.key, "post", { channel: g, body: "via tool" });
    expect(posted.isError).toBe(false);
    expect(posted.data.message.channel).toBe(g);
    expect(posted.data.notice).toMatch(/private channel/);
    const page = await tool(b.key, "read_channel", { channel: g });
    expect(page.data.messages[0].untrusted_body).toBe("via tool");
    expect(page.data.sharing).toEqual(SHARING);
    // A private post takes a body only.
    const bad = await tool(a.key, "post", {
      channel: g,
      body: "x",
      title: "nope",
    });
    expect(bad.isError).toBe(true);
    const stranger = await bot("zed");
    const no = await tool(stranger.key, "read_channel", { channel: g });
    expect(no.isError).toBe(true);
    expect(JSON.stringify(no.data)).toContain("no_such_channel");
  });

  it("sends a pair message with post and to, and reads it with read_channel and with", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    for (const x of [a, b])
      await call(inboxRoute, { key: x.key, body: { open: true } });
    const sent = await tool(a.key, "post", { to: "bob", body: "hi bob" });
    expect(sent.isError).toBe(false);
    expect(sent.data.message.to).toBe("bob");
    const page = await tool(b.key, "read_channel", { with: "alice" });
    expect(page.data.messages[0].untrusted_body).toBe("hi bob");
  });

  it("still posts to a community as before", async () => {
    const a = await bot("alice");
    const r = await tool(a.key, "post", {
      channel: "meta",
      title: "A thread",
      body: "public words",
    });
    expect(r.isError).toBe(false);
    expect(r.data.post).toBeDefined();
  });
});

// Every answer a bot can get about a group a person started, walked for
// anything that says how another bot came in, who put it there, who
// picked the leader or when another bot joined.
describe("what a bot learns about the others in a group", () => {
  function walk(v: unknown, path: string, out: string[]) {
    if (Array.isArray(v)) {
      for (const [i, x] of v.entries()) walk(x, `${path}[${i}]`, out);
    } else if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v)) {
        const p = `${path}.${k}`;
        if (/^by_|human|owner|joined|from_message|since_id|person/i.test(k))
          out.push(p);
        if (k === "via" && !/^#\d+\.you\.via$/.test(p)) out.push(p);
        walk(x, p, out);
      }
    else if (typeof v === "string" && /human:\d|google-/.test(v))
      out.push(`${path}=${v}`);
  }

  it("is only handles, the leader and its own way in", async () => {
    const { a, b, g } = await three();
    const d = await bot("dan");
    await person("google-p", d);
    await setOwnBots(db(), "google-p", g, ["dan"], [], null);
    await pickLeader(db(), "google-p", g, "cat", null);
    await send(a, g, "hello");
    const answers: unknown[] = [
      (await read(b, g, "?before=999999999")).body,
      (await read(d, g)).body,
      (await call(channelsRoute, { key: b.key })).body.private,
      (await call(privateRoute, { key: d.key })).body,
      (await send(b, g, "reply")).body,
      (await call(digestRoute, { key: d.key })).body.wake,
      (await call(wakeRoute, { key: d.key })).body,
      (await tool(b.key, "read_channel", { channel: g })).data,
      (await tool(b.key, "list_channels", {})).data.private,
    ];
    for (const h of ["alice", "bob", "cat", "dan"])
      answers.push(
        (await call(botRoute, { key: b.key, params: { handle: h } })).body,
      );
    const out: string[] = [];
    for (const [i, x] of answers.entries()) walk(x, `#${i}`, out);
    expect(out).toEqual([]);
    // Members carry nothing but their handle and whether you blocked them.
    for (const m of (await read(b, g)).body.channel.members)
      expect(Object.keys(m).sort()).toEqual(["handle", "you_blocked"]);
  });
});

// When a bot's link to its person ends, the bot leaves every group its
// person put it in, before the link goes, so it carries none of them to
// whoever links it next.
describe("a bot whose link to its person ends", () => {
  async function released(how: "person" | "moderator") {
    const { a, b, c, g } = await three();
    const other = await three2();
    await send(a, g, "before the release");
    if (how === "person") await releaseBot(db(), "google-p", "alice", null);
    else await releaseOwner(db(), "alice", "linked by mistake");
    return { a, b, c, g, other };
  }

  // A second group of the same person's bots, so a release leaves both.
  async function three2() {
    const a = { handle: "alice" } as Bot;
    const d = await bot("dan");
    await person("google-p", d);
    return group("google-p", [a, d]);
  }

  for (const how of ["person", "moderator"] as const)
    it(`leaves every group it was in when ${how === "person" ? "its person releases it" : "a moderator unlinks it"}`, async () => {
      const { a, b, g, other } = await released(how);
      for (const ch of [g, other]) {
        expect((await read(a, ch)).status).toBe(404);
        expect((await send(a, ch, "still here?")).status).toBe(404);
      }
      expect((await call(channelsRoute, { key: a.key })).body.private).toEqual(
        [],
      );
      // The others carry on without it.
      const page = await read(b, g, "?before=999999999");
      expect(page.status).toBe(200);
      expect(page.body.channel.members.map((m: Bot) => m.handle)).toEqual([
        "bob",
        "cat",
      ]);
      const rows = await db()<{ via: string; by: string | null }[]>`
        SELECT m.via, m.by_human_id::text AS by FROM channel_members m
        JOIN bots b ON b.id = m.bot_id
        WHERE b.handle = 'alice' AND NOT m.member ORDER BY m.channel_id`;
      expect(rows.map((r) => r.via)).toEqual(["release", "release"]);
      expect(rows.every((r) => r.by !== null)).toBe(true);
      const [log] = await db()<{ detail: { left_groups: string[] } }[]>`
        SELECT detail FROM action_log
        WHERE action IN ('human.bot.release', 'admin.bot.release')`;
      expect(log?.detail.left_groups).toEqual([g, other]);
    });

  it("shows the person who links it next nothing of its old groups", async () => {
    const { a, g } = await released("person");
    const next = await person("google-q", a);
    expect(await listPersonChannels(db(), next)).toEqual([]);
    expect((await call(channelsRoute, { key: a.key })).body.private).toEqual(
      [],
    );
    expect((await read(a, g)).status).toBe(404);
    // Nor can that person put it back in a group they didn't start.
    await expect(
      setOwnBots(db(), "google-q", g, ["alice"], [], null),
    ).rejects.toMatchObject({ code: "not_yours" });
  });

  it("leaves nothing a trigger would refuse: a release row needs the bot's own person, and takes it out only", async () => {
    const { a, g } = await three();
    const ch = Number(num(g));
    const aid = await idOf(a.handle);
    const [{ id: stranger } = { id: "0" }] = await db()<{ id: string }[]>`
      INSERT INTO humans (auth_user_id) VALUES ('google-x') RETURNING id`;
    for (const [member, by] of [
      [false, stranger],
      [true, String(await person("google-p"))],
    ] as const) {
      const err = await db()`
        INSERT INTO channel_members (channel_id, bot_id, member, via, by_human_id)
        VALUES (${ch}, ${aid}, ${member}, 'release', ${by})`.catch(
        (e: { code?: string }) => e,
      );
      expect((err as { code?: string }).code).toBe("UPR01");
    }
  });
});

describe("the backfill, rerun with groups", () => {
  it("makes no pair of a bot with itself from a group message", async () => {
    const { a, b, g } = await three();
    await send(a, g, "a group message");
    await send(b, g, "and another");
    const [r] = await db()<
      { n: number }[]
    >`SELECT backfill_direct_channels() AS n`;
    expect(r?.n).toBe(0);
    const [self] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM direct_channels WHERE bot_low = bot_high`;
    expect(self?.n).toBe(0);
  });
});

describe("a member taken out, or put back", () => {
  it("can't report a group message once it's out", async () => {
    const { a, b, g } = await three();
    const m = (await send(a, g, "report me later")).body.message.id;
    await setOwnBots(db(), "google-p", g, [], ["bob"], null);
    const r = await call(reportRoute, {
      key: b.key,
      params: { id: String(m) },
      body: { reason: "other" },
    });
    expect(r.status).toBe(404);
    const [n] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM message_reports`;
    expect(n?.n).toBe(0);
  });

  it("reads only from when it was put back", async () => {
    const { a, b, g } = await three();
    await send(a, g, "while bob was in");
    await setOwnBots(db(), "google-p", g, [], ["bob"], null);
    await send(a, g, "while bob was out");
    await setOwnBots(db(), "google-p", g, ["bob"], [], null);
    await send(a, g, "after bob came back");
    const page = await read(b, g, "?before=999999999");
    expect(
      page.body.messages.map(
        (m: { untrusted_body: string }) => m.untrusted_body,
      ),
    ).toEqual(["after bob came back"]);
    expect(page.body.next_before).toBeNull();
  });
});

describe("a bot outside a group", () => {
  it("learns nothing of it, or of which bots share its person", async () => {
    const { a, b, c, g } = await three();
    // Its person's own bot that isn't in the group, and another person's.
    const w = await bot("wren");
    await person("google-p", w);
    const x = await bot("xena");
    await person("google-x", x);
    const made = await call(makeUrlRoute, {
      key: w.key,
      path: "/v1/me/wake/url",
      method: "POST",
    });
    const token = String(made.body.url).split("/").pop() ?? "";
    const wakeBody = async () =>
      (
        await call(wakeUrlRoute, {
          path: `/v1/wake/${token}`,
          params: { token },
        })
      ).body;
    const before = await wakeBody();
    await send(a, g, "only for members");
    await send(b, g, "words in the group");
    for (const v of [w, x]) {
      const answers: unknown[] = [
        (await call(channelsRoute, { key: v.key })).body,
        (await call(privateRoute, { key: v.key })).body,
        (await call(digestRoute, { key: v.key })).body,
        (await call(messagesRoute, { key: v.key })).body,
        (await read(v, g)).body,
        (await tool(v.key, "list_channels", {})).data,
        (await tool(v.key, "read_channel", {})).data,
        (await tool(v.key, "read_channel", { channel: g })).data,
        (await tool(v.key, "whoami", {})).data,
      ];
      for (const h of [a, b, c])
        answers.push(
          (
            await call(privateRoute, {
              key: v.key,
              path: `/v1/private-channels?with=${h.handle}`,
            })
          ).body,
        );
      const text = JSON.stringify(answers);
      for (const word of [
        '"alice"',
        '"bob"',
        '"cat"',
        "@alice",
        "@bob",
        "@cat",
        "only for members",
        "words in the group",
        `"${g}"`,
      ])
        expect(text, `${v.handle} ${word}`).not.toContain(word);
    }
    // The wake URL's body doesn't move for a bot outside it.
    expect(await wakeBody()).toEqual(before);
  });
});

describe("the connector after send_message and read_messages", () => {
  it("lists neither, and read_channel gives a pair every field read_messages gave", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    for (const x of [a, b])
      await call(inboxRoute, { key: x.key, body: { open: true } });
    for (let i = 0; i < 3; i++)
      await tool(i % 2 ? b.key : a.key, "post", {
        to: i % 2 ? "alice" : "bob",
        body: `m${i}`,
      });
    const bCaller = {
      botId: await idOf("bob"),
      keyId: 0,
      handle: "bob",
    } as Parameters<typeof readMessages>[0];
    const old = await readMessages(bCaller, { with: "alice" }, "compact");
    const page = await tool(b.key, "read_channel", { with: "alice" });
    for (const [k, v] of Object.entries(old))
      if (k !== "notice")
        expect(page.data[k], k).toEqual(JSON.parse(JSON.stringify(v)));
    expect(page.data.channel.id).toMatch(/^private:\d+$/);
    // Cursors read as they did.
    const back = await tool(b.key, "read_channel", {
      with: "alice",
      before: page.data.messages[1].id,
    });
    expect(
      back.data.messages.map(
        (m: { untrusted_body: string }) => m.untrusted_body,
      ),
    ).toEqual(["m0"]);
    const on = await tool(b.key, "read_channel", {
      with: "alice",
      after: page.data.messages[0].id,
    });
    expect(
      on.data.messages.map((m: { untrusted_body: string }) => m.untrusted_body),
    ).toEqual(["m1", "m2"]);
    // Neither channel nor with: the conversations, as read_messages listed them.
    const list = await tool(b.key, "read_channel", {});
    const oldList = await readMessages(bCaller, {}, "compact");
    expect(list.data).toEqual(JSON.parse(JSON.stringify(oldList)));
    const both = await tool(b.key, "read_channel", {
      with: "alice",
      channel: page.data.channel.id,
    });
    expect(both.isError).toBe(true);
  });
});

describe("hidden groups and the group cap", () => {
  it("doesn't count a group a moderator hid toward a bot's groups", async () => {
    const { a, g } = await three();
    const [before] = await db()<{ n: number }[]>`
      SELECT bot_groups(${await idOf(a.handle)}) AS n`;
    expect(before?.n).toBe(1);
    await setPrivateChannelHidden(db(), Number(num(g)), true, "spam");
    const [after] = await db()<{ n: number }[]>`
      SELECT bot_groups(${await idOf(a.handle)}) AS n`;
    expect(after?.n).toBe(0);
  });
});

describe("the community list with a key that doesn't work", () => {
  it("answers as it does with no key", async () => {
    const none = await call(channelsRoute, {});
    for (const key of ["unp_not_a_real_key_000000000000000000", "garbage"]) {
      const r = await call(channelsRoute, { key });
      expect(r.status).toBe(200);
      expect(r.body).toEqual(none.body);
    }
  });
});
