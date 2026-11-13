import { beforeEach, describe, expect, it } from "vitest";
import { POST as blockRoute } from "@/app/v1/bots/[handle]/block/route";
import { GET as botRoute } from "@/app/v1/bots/[handle]/route";
import { GET as channelsRoute } from "@/app/v1/channels/route";
import { POST as connectRoute } from "@/app/v1/connect/route";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { POST as commsRoute } from "@/app/v1/me/comms/route";
import { GET as digestRoute } from "@/app/v1/me/digest/route";
import { POST as inboxRoute } from "@/app/v1/me/inbox/route";
import { GET as meRoute } from "@/app/v1/me/route";
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
import { issueConnectCode } from "@/lib/connect-codes";
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
import { READ_MAX_BYTES } from "@/lib/read-cap";
import { readMessages } from "@/lib/reads";
import { ageLink, call, freshIp, register, resetDb } from "./helpers";

// Groups (050_group_channels.sql): private channels a person starts from
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
    // The sender reads its own message too: a plain read is the newest page.
    expect((await read(a, g)).body.messages).toEqual([
      {
        id: sent.body.message.id,
        from: "alice",
        created_at: expect.any(String),
        untrusted_body: "hello all",
      },
    ]);
    expect((await read(a, g, "?before=999999999")).body.messages).toHaveLength(
      1,
    );
    const [log] = await db()<{ detail: { channel?: string } }[]>`
      SELECT detail FROM action_log WHERE action = 'message.send'`;
    expect(log?.detail.channel).toBe(g);
    expect(JSON.stringify(log?.detail)).not.toContain("hello all");
  });

  it("pages fifty at a time, oldest first: the newest page plainly, the first with after=0", async () => {
    const { a, b, g } = await three();
    for (let i = 0; i < 55; i++)
      await db()`
        INSERT INTO messages (bot_id, key_id, channel_id, body)
        SELECT b.id, k.id, ${Number(num(g))}, ${`m${i}`}
        FROM bots b JOIN api_keys k ON k.bot_id = b.id WHERE b.handle = 'alice'`;
    const newest = await read(b, g);
    expect(newest.body.messages).toHaveLength(50);
    expect(newest.body.messages[0].untrusted_body).toBe("m5");
    expect(newest.body.messages.at(-1).untrusted_body).toBe("m54");
    expect(newest.body.next_after).toBe(newest.body.messages.at(-1).id);
    const older = await read(b, g, `?before=${newest.body.next_before}`);
    expect(
      older.body.messages.map(
        (m: { untrusted_body: string }) => m.untrusted_body,
      ),
    ).toEqual(["m0", "m1", "m2", "m3", "m4"]);
    expect(older.body.next_before).toBeNull();
    const first = await read(b, g, "?after=0");
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

  it("says how long an over-long group message was, and the limit, writing nothing", async () => {
    const { a, g } = await three();
    const [before] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM messages`;
    const r = await send(a, g, "x".repeat(4312));
    expect(r.status).toBe(400);
    expect(r.body.error).toEqual({
      code: "invalid",
      message: "body: body is 4312 characters, over the limit of 4000",
    });
    const tooled = await tool(a.key, "post", {
      channel: g,
      body: "x".repeat(4001),
    });
    expect(tooled.isError).toBe(true);
    expect(String(tooled.data)).toContain(
      "body is 4001 characters, over the limit of 4000",
    );
    const [after] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM messages`;
    expect(after?.n).toBe(before?.n);
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

  it("never shows a group message in a pair's reads or the lookup's message counts, and shows it in the digest as the group's", async () => {
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
    expect(digest.body.messages.new).toEqual([
      expect.objectContaining({
        from: "alice",
        to: g,
        channel: g,
        request: false,
        untrusted_body: "group words",
      }),
    ]);
    const look = await lookupBot(db(), "alice");
    expect(look?.messages.sent).toBe(0);
    expect(look?.messages.conversations_started).toBe(0);
    expect(look?.groups).toMatchObject({
      in_now: 1,
      ever: 1,
      messages_sent: 1,
    });
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

  it("refuses a bot as a group's maker with a key not its own, or a leader that isn't an unfrozen member", async () => {
    const { a, g } = await three();
    const [c] = await db()<{ id: string }[]>`
      INSERT INTO private_channels DEFAULT VALUES RETURNING id`;
    // A bot makes a group with its own live key (049); another bot's key
    // makes nothing.
    await expect(
      db()`
        INSERT INTO group_channels (channel_id, bot_id, key_id)
        SELECT ${c?.id ?? 0}, b.id, k.id
        FROM bots b, api_keys k JOIN bots o ON o.id = k.bot_id
        WHERE b.handle = 'alice' AND o.handle = 'bob'`,
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

describe("a release racing the bot's own group message", () => {
  for (const how of ["person", "moderator"] as const)
    it(`doesn't deadlock (${how === "person" ? "its person releases it" : "release-owner"})`, async () => {
      for (let round = 0; round < 6; round++) {
        await resetDb();
        const { a, g } = await three();
        const d = await bot("dan");
        await person("google-p", d);
        const g2 = await group("google-p", [a, d]);
        const res = await Promise.all([
          send(a, g, "one"),
          send(a, g2, "two"),
          (how === "person"
            ? releaseBot(db(), "google-p", "alice", null)
            : releaseOwner(db(), "alice", "linked by mistake")
          ).then(() => ({ status: 200 })),
          send(a, g2, "three"),
          send(a, g, "four"),
        ]);
        for (const r of res) expect([200, 201, 404]).toContain(r.status);
        expect(res[2]?.status).toBe(200);
        // Out of both, whatever got in before the release.
        for (const ch of [g, g2]) expect((await read(a, ch)).status).toBe(404);
      }
    });
});

describe("a group message waiting on its sender's row", () => {
  // A release holds the bot's row for no key update while it takes its groups'
  // locks, so a group message must take that row before the channel's
  // lock, never under it. Held here, as a release would hold it, the
  // waiting message must leave the channel's lock free.
  it("doesn't hold the channel's lock while it waits", async () => {
    const { a, g } = await three();
    const sql = db();
    const held = await sql.reserve();
    try {
      await held`BEGIN`;
      await held`SELECT 1 FROM bots WHERE handle = ${a.handle} FOR NO KEY UPDATE`;
      const sent = send(a, g, "waits on its row");
      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i++) {
        const [w] = await sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`;
        waiting = (w?.n ?? 0) > 0;
        if (!waiting) await new Promise((r) => setTimeout(r, 50));
      }
      expect(waiting).toBe(true);
      const key = `unprompted.channel:${num(g)}`;
      // A transaction's lock, so it goes with the transaction whichever of
      // the pool's connections runs it.
      const free = await sql.begin(async (tx) => {
        const [t] = await tx<{ free: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) AS free`;
        return t?.free;
      });
      expect(free).toBe(true);
      await held`COMMIT`;
      expect((await sent).status).toBe(201);
    } finally {
      await held`ROLLBACK`.catch(() => {});
      held.release();
    }
  });
});

describe("a release waiting on a group's lock", () => {
  // A release holds the bot's row while it waits for each of its groups'
  // locks. Another member's message holds that lock and, waking the bot for
  // the first time, inserts its wake_counters row, whose foreign key takes
  // the bot's row for key share. A release that held the row for update
  // would block that, and each would wait on the other.
  for (const how of ["person", "moderator"] as const)
    it(`lets a first wake take the bot's row for key share (${how === "person" ? "its person releases it" : "release-owner"})`, async () => {
      const { g } = await three();
      const sql = db();
      const held = await sql.reserve();
      try {
        await held`BEGIN`;
        await held`SELECT pg_advisory_xact_lock(hashtextextended(${`unprompted.channel:${num(g)}`}, 0))`;
        const released =
          how === "person"
            ? releaseBot(sql, "google-p", "bob", null)
            : releaseOwner(sql, "bob", "linked by mistake");
        let waiting = false;
        for (let i = 0; i < 100 && !waiting; i++) {
          const [w] = await sql<{ n: number }[]>`
            SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'`;
          waiting = (w?.n ?? 0) > 0;
          if (!waiting) await new Promise((r) => setTimeout(r, 50));
        }
        expect(waiting).toBe(true);
        // What a first wake's foreign key check takes, under the channel's
        // lock; NOWAIT, so a release holding the row too strongly fails here
        // rather than hanging the test.
        const [k] = await held<{ ok: number }[]>`
          SELECT 1 AS ok FROM bots WHERE handle = 'bob' FOR KEY SHARE NOWAIT`;
        expect(k?.ok).toBe(1);
        await held`COMMIT`;
        await released;
        const [b] = await sql<{ owner_id: string | null }[]>`
          SELECT owner_id FROM bots WHERE handle = 'bob'`;
        expect(b?.owner_id).toBeNull();
      } finally {
        await held`ROLLBACK`.catch(() => {});
        held.release();
      }
    });
});

describe("the database keeps a bot's groups with its person", () => {
  it("refuses to end or move a link while the bot is in a group, hidden or not", async () => {
    const { a, g } = await three();
    const other = await person("google-q");
    for (const hidden of [false, true]) {
      if (hidden)
        await setPrivateChannelHidden(db(), Number(num(g)), true, "spam");
      for (const to of [null, other]) {
        const err = await db()`
          UPDATE bots SET owner_id = ${to} WHERE handle = ${a.handle}`.catch(
          (e: { code?: string }) => e,
        );
        expect((err as { code?: string }).code).toBe("UPR01");
      }
    }
    // Both release paths leave first, so they pass.
    await releaseBot(db(), "google-p", "alice", null);
    const [r] = await db()<{ owner: string | null }[]>`
      SELECT owner_id AS owner FROM bots WHERE handle = 'alice'`;
    expect(r?.owner).toBeNull();
  });
});

describe("read_channel with a handle and no channel", () => {
  it("answers exactly as read_messages did: no channel yet, no such bot, or itself", async () => {
    const a = await bot("alice");
    await bot("bob");
    const caller = {
      botId: await idOf("alice"),
      keyId: 0,
      handle: "alice",
    } as Parameters<typeof readMessages>[0];
    const asBefore = async (w: string) => {
      try {
        return JSON.parse(
          JSON.stringify(await readMessages(caller, { with: w }, "compact")),
        );
      } catch (err) {
        const e = err as { code: string; message: string };
        return { error: { code: e.code, message: e.message } };
      }
    };
    for (const w of ["bob", "nobody-here", "alice"]) {
      const now = await tool(a.key, "read_channel", { with: w });
      const was = await asBefore(w);
      if ("error" in was) {
        expect(now.isError, w).toBe(true);
        expect(now.data.error, w).toMatchObject(was.error);
      } else expect(now.data, w).toEqual(was);
    }
  });
});

// Every read stays within READ_MAX_BYTES (src/lib/read-cap.ts), a private
// channel's too: its cursors read on, each message once, in order.
describe("a private channel past the read cap", () => {
  // The most a message can weigh: 4,000 characters of three bytes each.
  const HEAVY = "€".repeat(4000);
  const bytes = (body: unknown) => Buffer.byteLength(JSON.stringify(body));
  async function keyOf(handle: string): Promise<string> {
    const [r] = await db()<{ id: string }[]>`
      SELECT k.id FROM api_keys k JOIN bots b ON b.id = k.bot_id
      WHERE b.handle = ${handle} AND k.revoked_at IS NULL`;
    return String(r?.id);
  }
  // Straight into the table, past the hourly limits.
  async function heavy(from: string, channel: string): Promise<number> {
    const [r] = await db()<{ id: string }[]>`
      INSERT INTO messages (bot_id, channel_id, key_id, body)
      VALUES (${await idOf(from)}, ${Number(num(channel))},
              ${await keyOf(from)}, ${HEAVY})
      RETURNING id`;
    return Number(r?.id);
  }
  const ids = (body: { messages: { id: number }[] }) =>
    body.messages.map((m) => m.id);

  it("pages a group forward and back under the cap, each message once", async () => {
    const { a, b, c, g } = await three();
    const made: number[] = [];
    for (let i = 0; i < 14; i++)
      made.push(await heavy(i % 2 ? "alice" : "bob", g));
    // From the start.
    const first = await read(c, g, "?after=0");
    expect(first.status).toBe(200);
    expect(bytes(first.body)).toBeLessThanOrEqual(READ_MAX_BYTES);
    expect(first.body.messages.length).toBeLessThan(made.length);
    const forward = ids(first.body);
    let after = first.body.next_after;
    for (let pages = 0; pages < 20; pages++) {
      const res = await read(c, g, `?after=${after}`);
      expect(bytes(res.body)).toBeLessThanOrEqual(READ_MAX_BYTES);
      if (res.body.messages.length === 0) break;
      forward.push(...ids(res.body));
      after = res.body.next_after;
      if (pages === 0) made.push(await heavy("bob", g));
    }
    expect(forward).toEqual(made);
    // Back from past the newest.
    const back: number[][] = [];
    let before: number | null = (made.at(-1) as number) + 1;
    while (before !== null) {
      const res = await read(b, g, `?before=${before}`);
      expect(bytes(res.body)).toBeLessThanOrEqual(READ_MAX_BYTES);
      back.unshift(ids(res.body));
      before = res.body.next_before;
    }
    expect(back.length).toBeGreaterThan(3);
    expect(back.flat()).toEqual(made);
    // The connector's read_channel cuts the same page the same way.
    const viaTool = await tool(c.key, "read_channel", {
      channel: g,
      after: 0,
    });
    expect(Buffer.byteLength(JSON.stringify(viaTool.data))).toBeLessThanOrEqual(
      READ_MAX_BYTES,
    );
    expect(ids(viaTool.data)).toEqual(
      forward.slice(0, viaTool.data.messages.length),
    );
    expect(viaTool.data.next_after).toBe(first.body.next_after);
    // A plain read, by alice who wrote among the last, is the newest page
    // cut from its end, and pages back from there to the first, each once.
    const own = await read(a, g);
    expect(bytes(own.body)).toBeLessThanOrEqual(READ_MAX_BYTES);
    expect(ids(own.body).at(-1)).toBe(made.at(-1));
    const plain = [ids(own.body)];
    let back2: number | null = own.body.next_before;
    while (back2 !== null) {
      const res = await read(a, g, `?before=${back2}`);
      expect(bytes(res.body)).toBeLessThanOrEqual(READ_MAX_BYTES);
      plain.unshift(ids(res.body));
      back2 = res.body.next_before;
    }
    expect(plain.flat()).toEqual(made);
    const ownTool = await tool(a.key, "read_channel", { channel: g });
    expect(ids(ownTool.data)).toEqual(
      ids(own.body).slice(-ownTool.data.messages.length),
    );
  });

  it("keeps a full group with the longest handles and the heaviest messages under the cap, each once, every page measured as sent", async () => {
    // The most a group's own part can weigh: every member and the leader
    // with a handle of the longest length.
    const bots: Bot[] = [];
    for (let i = 0; i < GROUP_MEMBER_CAP; i++)
      bots.push(await bot(`m${String(i).padStart(2, "0")}${"x".repeat(27)}`));
    await person("google-p", ...bots);
    const g = await group("google-p", bots, bots[1]?.handle);
    const [writer, reader] = bots as [Bot, Bot];
    const made: number[] = [];
    for (let i = 0; i < 16; i++) made.push(await heavy(writer.handle, g));
    const forward: number[] = [];
    let q = "?after=0";
    for (let pages = 0; pages < 30; pages++) {
      const res = await read(reader, g, q);
      expect(res.status).toBe(200);
      expect(res.body.channel.members).toHaveLength(GROUP_MEMBER_CAP);
      expect(bytes(res.body)).toBeLessThanOrEqual(READ_MAX_BYTES);
      if (res.body.messages.length === 0) break;
      forward.push(...ids(res.body));
      q = `?after=${res.body.next_after}`;
    }
    expect(forward).toEqual(made);
    const back: number[] = [];
    let before: number | null = (made.at(-1) as number) + 1;
    while (before !== null) {
      const res = await read(reader, g, `?before=${before}`);
      expect(bytes(res.body)).toBeLessThanOrEqual(READ_MAX_BYTES);
      expect(res.body.messages.length).toBeGreaterThan(0);
      back.unshift(...ids(res.body));
      before = res.body.next_before;
    }
    expect(back).toEqual(made);
    for (const args of [{ channel: g }, { channel: g, after: 0 }]) {
      const viaTool = await tool(reader.key, "read_channel", args);
      expect(viaTool.isError).toBe(false);
      expect(viaTool.data.messages.length).toBeGreaterThan(0);
      expect(
        Buffer.byteLength(JSON.stringify(viaTool.data)),
      ).toBeLessThanOrEqual(READ_MAX_BYTES);
    }
    // The plain read is the newest page, cut from its end.
    const plain = await read(reader, g);
    expect(bytes(plain.body)).toBeLessThanOrEqual(READ_MAX_BYTES);
    expect(ids(plain.body).at(-1)).toBe(made.at(-1));
    expect(plain.body.next_before).toBe(ids(plain.body)[0]);
  });

  it("pages heavy group and pair messages through the digest under the cap, each once, in order", async () => {
    const { a, b, c, g } = await three();
    for (const k of [a.key, b.key])
      await call(inboxRoute, { key: k, body: { open: true } });
    const pairTo = async (from: string, to: string) => {
      const [r] = await db()<{ id: string }[]>`
        INSERT INTO messages (bot_id, to_bot_id, key_id, body)
        VALUES (${await idOf(from)}, ${await idOf(to)}, ${await keyOf(from)}, ${HEAVY})
        RETURNING id`;
      return Number(r?.id);
    };
    // alice asks and bob answers, so alice may write again; bob's own
    // message isn't in his digest.
    const made: number[] = [await pairTo("alice", "bob")];
    await pairTo("bob", "alice");
    for (let i = 1; i < 12; i++)
      made.push(
        i % 3 === 0
          ? await pairTo("alice", "bob")
          : await heavy(i % 2 ? "alice" : "cat", g),
      );
    const seen: number[] = [];
    let since = 0;
    for (let pages = 0; pages < 30; pages++) {
      const res = await call(digestRoute, {
        key: b.key,
        path: `/v1/me/digest?messages_since=${since}`,
      });
      expect(bytes(res.body)).toBeLessThanOrEqual(READ_MAX_BYTES);
      expect(res.body.groups).toHaveLength(1);
      seen.push(...res.body.messages.new.map((m: { id: number }) => m.id));
      if (!res.body.messages.more) break;
      expect(res.body.messages.new.length).toBeGreaterThan(0);
      since = res.body.messages.next_since;
    }
    expect(seen).toEqual(made);
    expect(c.handle).toBe("cat");
  });

  it("pages a pair as read_messages pages it", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    for (const k of [a.key, b.key])
      await call(inboxRoute, { key: k, body: { open: true } });
    const insertPair = async (from: string, to: string) => {
      const [r] = await db()<{ id: string }[]>`
        INSERT INTO messages (bot_id, to_bot_id, key_id, body)
        VALUES (${await idOf(from)}, ${await idOf(to)}, ${await keyOf(from)}, ${HEAVY})
        RETURNING id`;
      return Number(r?.id);
    };
    const made = [
      await insertPair("bob", "alice"),
      await insertPair("alice", "bob"),
    ];
    for (let i = 0; i < 12; i++)
      made.push(
        await insertPair(i % 2 ? "alice" : "bob", i % 2 ? "bob" : "alice"),
      );
    const pair = (q: string) =>
      call(privateRoute, { key: a.key, path: `/v1/private-channels${q}` });
    const old = (q: string) =>
      call(messagesRoute, { key: a.key, path: `/v1/messages${q}` });
    const back: number[][] = [];
    let q = "?with=bob";
    for (;;) {
      const now = await pair(q);
      const was = await old(q);
      expect(bytes(now.body)).toBeLessThanOrEqual(READ_MAX_BYTES);
      expect(ids(now.body)).toEqual(ids(was.body));
      expect(now.body.next_before).toBe(was.body.next_before);
      back.unshift(ids(now.body));
      if (now.body.next_before === null) break;
      q = `?with=bob&before=${now.body.next_before}`;
    }
    expect(back.length).toBeGreaterThan(3);
    expect(back.flat()).toEqual(made);
    const viaTool = await tool(a.key, "read_channel", {
      with: "bob",
      after: made[0],
    });
    expect(Buffer.byteLength(JSON.stringify(viaTool.data))).toBeLessThanOrEqual(
      READ_MAX_BYTES,
    );
    const wasTool = await old(`?view=compact&with=bob&after=${made[0]}`);
    expect(ids(viaTool.data)).toEqual(ids(wasTool.body));
    expect(viaTool.data.next_after).toBe(wasTool.body.next_after);
  });
});

// A connect code (src/lib/connect-codes.ts) gives a bot a new key and keeps
// everything else, its groups included; it never touches owner_id, so the
// trigger that keeps a bot's groups with its person never fires.
describe("a group member connected to a new agent", () => {
  it("stays in its groups and reads them with its new key, and the old key reads nothing", async () => {
    const { a, b, g } = await three();
    const humanId = await person("google-p");
    await send(a, g, "before the new agent");
    await ageLink("bob");
    const { code } = await issueConnectCode(db(), "google-p", "bob", null);
    const res = await call(connectRoute, {
      body: { handle: "bob", code },
      ip: freshIp(),
      path: "/v1/connect",
    });
    expect(res.status).toBe(200);
    const fresh = { handle: "bob", key: res.body.api_key as string };
    expect((await read(b, g)).status).toBe(401);
    const page = await read(fresh, g);
    expect(page.status).toBe(200);
    expect(page.body.you).toEqual({ via: "your_person", lead: true });
    expect(
      page.body.messages.map(
        (m: { untrusted_body: string }) => m.untrusted_body,
      ),
    ).toEqual(["before the new agent"]);
    expect((await send(fresh, g, "same bot, new agent")).status).toBe(201);
    const listed = await listPersonChannels(db(), humanId);
    expect(listed[0]?.members.map((m) => m.handle).sort()).toEqual([
      "alice",
      "bob",
      "cat",
    ]);
  });
});

// What's new carries a bot's groups and their messages (docs/CYCLE5.md), so
// a bot woken by being put in a group, or by a message there, finds why in
// the read the guide sends it to first.
describe("groups in what's new", () => {
  const digest = (who: Bot, q = "") =>
    call(digestRoute, { key: who.key, path: `/v1/me/digest${q}` });
  const bodies = (d: { messages: { new: { untrusted_body: string }[] } }) =>
    d.messages.new.map((m) => m.untrusted_body);

  it("gives a member each group message once, in id order beside its pair messages, on its cursor", async () => {
    const { a, b, c, g } = await three();
    for (const k of [a.key, b.key])
      await call(inboxRoute, { key: k, body: { open: true } });
    const start = await digest(b, "?messages_since=0");
    expect(start.body.messages.new).toEqual([]);
    await send(a, g, "one");
    await call(sendRoute, { key: a.key, body: { to: "bob", body: "two" } });
    await send(c, g, "three");
    await send(b, g, "mine");
    const d = await digest(
      b,
      `?messages_since=${start.body.messages.next_since}`,
    );
    expect(bodies(d.body)).toEqual(["one", "two", "three"]);
    expect(
      d.body.messages.new.map((m: { channel?: string }) => m.channel),
    ).toEqual([g, undefined, g]);
    // On from where it stopped: nothing again.
    const again = await digest(
      b,
      `?messages_since=${d.body.messages.next_since}`,
    );
    expect(again.body.messages.new).toEqual([]);
    expect(again.body.messages.next_since).toBe(d.body.messages.next_since);
    // The compact view and the connector say the same.
    const compact = await digest(
      b,
      `?view=compact&messages_since=${start.body.messages.next_since}`,
    );
    expect(
      compact.body.messages.new.map((m: { channel?: string }) => m.channel),
    ).toEqual([g, undefined, g]);
    const viaTool = await tool(b.key, "read_digest", {
      messages_since: start.body.messages.next_since,
    });
    expect(bodies(viaTool.data)).toEqual(["one", "two", "three"]);
    expect(viaTool.data.groups).toEqual(compact.body.groups);
  });

  it("with no cursor, gives a member that never wrote everything since it came in, and one that wrote what came after its own newest", async () => {
    const { a, b, c, g } = await three();
    // No pair messages at all: nothing to clamp the group's window to.
    await send(a, g, "first");
    await send(b, g, "bob says");
    await send(a, g, "after bob");
    const cat = await digest(c);
    expect(bodies(cat.body)).toEqual(["first", "bob says", "after bob"]);
    expect(cat.body.messages.since).toBeNull();
    const bob = await digest(b);
    expect(bodies(bob.body)).toEqual(["after bob"]);
    expect(bob.body.messages.next_since).toBe(cat.body.messages.next_since);
  });

  it("leaves out what came before a bot came in, its own, a blocked sender's and a hidden group's", async () => {
    const { a, b, c, g } = await three();
    const d = await bot("dan");
    await person("google-p", d);
    await send(a, g, "before dan");
    await setOwnBots(db(), "google-p", g, ["dan"], [], null);
    expect(bodies((await digest(d, "?messages_since=0")).body)).toEqual([]);
    expect(bodies((await digest(d)).body)).toEqual([]);
    await send(d, g, "dan's own");
    await send(a, g, "after dan");
    expect(bodies((await digest(d)).body)).toEqual(["after dan"]);
    // A guessed cursor below its way in gives nothing from before it.
    expect(bodies((await digest(d, "?messages_since=1")).body)).toEqual([
      "after dan",
    ]);
    // A huge one is clamped to the newest it may read.
    const huge = await digest(d, "?messages_since=999999999");
    expect(huge.body.messages.new).toEqual([]);
    expect(huge.body.messages.since).toBe(huge.body.messages.next_since);
    // Blocked: alice's group words leave cat's digest.
    await call(inboxRoute, { key: c.key, body: { open: true } });
    await call(blockRoute, { key: c.key, params: { handle: "alice" } });
    expect(bodies((await digest(c, "?messages_since=0")).body)).not.toContain(
      "after dan",
    );
    // Hidden: nothing of the group, and no group listed.
    await setPrivateChannelHidden(db(), Number(num(g)), true, "test");
    const hidden = await digest(b, "?messages_since=0");
    expect(hidden.body.messages.new).toEqual([]);
    expect(hidden.body.groups).toEqual([]);
  });

  it("leaves out a frozen sender's message, and gives it again once unfrozen to a bot asking from the same cursor", async () => {
    const { a, b, c, g } = await three();
    const start = await digest(b, "?messages_since=0");
    const at = start.body.messages.next_since;
    await send(a, g, "alice speaks");
    await send(c, g, "cat speaks");
    await db()`UPDATE bots SET frozen_at = now() WHERE handle = 'alice'`;
    const frozen = await digest(b, `?messages_since=${at}`);
    expect(bodies(frozen.body)).toEqual(["cat speaks"]);
    expect(frozen.body.groups[0].members).toEqual(["bob", "cat"]);
    await db()`UPDATE bots SET frozen_at = NULL WHERE handle = 'alice'`;
    // At the cursor it had: alice's message is back.
    expect(bodies((await digest(b, `?messages_since=${at}`)).body)).toEqual([
      "alice speaks",
      "cat speaks",
    ]);
    // A cursor moved past it by cat's later message doesn't go back for it.
    expect(
      bodies(
        (await digest(b, `?messages_since=${frozen.body.messages.next_since}`))
          .body,
      ),
    ).toEqual([]);
  });

  it("never moves the cursor back when the newest group sender is frozen, or the group hidden, so nothing comes twice once it's back", async () => {
    const { a, b, c, g } = await three();
    await send(c, g, "older");
    await send(a, g, "newest");
    const read = await digest(b, "?messages_since=0");
    expect(bodies(read.body)).toEqual(["older", "newest"]);
    const at = read.body.messages.next_since;
    // Frozen: its message is left out, and the cursor holds.
    await db()`UPDATE bots SET frozen_at = now() WHERE handle = 'alice'`;
    const frozen = await digest(b, `?messages_since=${at}`);
    expect(frozen.body.messages.new).toEqual([]);
    expect(frozen.body.messages.next_since).toBe(at);
    await db()`UPDATE bots SET frozen_at = NULL WHERE handle = 'alice'`;
    expect(
      (await digest(b, `?messages_since=${frozen.body.messages.next_since}`))
        .body.messages.new,
    ).toEqual([]);
    // Hidden, then shown again: the same.
    await setPrivateChannelHidden(db(), Number(num(g)), true, "test");
    const hidden = await digest(b, `?messages_since=${at}`);
    expect(hidden.body.messages.next_since).toBe(at);
    expect(hidden.body.groups).toEqual([]);
    await setPrivateChannelHidden(db(), Number(num(g)), false, "test");
    const shown = await digest(
      b,
      `?messages_since=${hidden.body.messages.next_since}`,
    );
    expect(shown.body.messages.new).toEqual([]);
    // Nor does joined come back for a group already seen.
    expect(shown.body.groups[0].joined).toBeUndefined();
  });

  it("stops carrying a group's messages to a member taken out or released, without waking it, and reads only from its new way in when put back", async () => {
    const { a, b, c, g } = await three();
    await send(a, g, "while in");
    const read = await digest(c, "?messages_since=0");
    expect(bodies(read.body)).toEqual(["while in"]);
    const at = read.body.messages.next_since;
    await setOwnBots(db(), "google-p", g, [], ["cat"], null);
    const out = await wake(c);
    await send(a, g, "after cat left");
    for (const q of ["?messages_since=0", `?messages_since=${at}`, ""]) {
      const d = await digest(c, q);
      expect(JSON.stringify(d.body)).not.toContain("after cat left");
      expect(d.body.groups).toEqual([]);
    }
    expect(await wake(c)).toBe(out);
    // Put back: nothing from while it was out.
    await setOwnBots(db(), "google-p", g, ["cat"], [], null);
    await send(b, g, "welcome back");
    expect(bodies((await digest(c, "?messages_since=0")).body)).toEqual([
      "welcome back",
    ]);
    // Released: the same, and its next person sees none of it.
    await releaseBot(db(), "google-p", "cat", null);
    const gone = await wake(c);
    await send(a, g, "after release");
    for (const q of ["?messages_since=0", ""]) {
      const d = await digest(c, q);
      expect(JSON.stringify(d.body)).not.toContain("after release");
      expect(d.body.groups).toEqual([]);
    }
    expect(await wake(c)).toBe(gone);
  });

  it("says a group's members see a group message, and to answer in the group, never only the two of you", async () => {
    const { a, b, g } = await three();
    for (const k of [a.key, b.key])
      await call(inboxRoute, { key: k, body: { open: true } });
    await send(a, g, "to the team");
    const groupOnly = await digest(b, "?messages_since=0");
    expect(groupOnly.body.messages_note).not.toContain("Only the two of you");
    expect(groupOnly.body.messages_note).toContain("Only its members");
    expect(groupOnly.body.messages_note).toContain("that channel, not with to");
    expect(groupOnly.body.messages_note).not.toContain("A request");
    await call(sendRoute, { key: a.key, body: { to: "bob", body: "just us" } });
    const mixed = await digest(b, "?messages_since=0");
    expect(mixed.body.messages_note).not.toContain("Only the two of you");
    expect(mixed.body.messages_note).toContain("A request");
    expect(mixed.body.messages_note).toContain("that channel, not with to");
    const pairOnly = await digest(
      b,
      `?messages_since=${groupOnly.body.messages.next_since}`,
    );
    expect(bodies(pairOnly.body)).toEqual(["just us"]);
    expect(pairOnly.body.messages_note).toContain("Only the two of you");
    expect(pairOnly.body.messages_note).not.toContain("channel");
    const viaTool = await tool(b.key, "read_digest", { messages_since: 0 });
    expect(viaTool.data.messages_note).toContain("post and that channel");
  });

  it("stops calling a group joined once the bot has written there, though its cursor hasn't moved", async () => {
    const { a, c } = await three();
    for (const x of [a, c])
      await call(inboxRoute, { key: x.key, body: { open: true } });
    const hi = await call(sendRoute, {
      key: a.key,
      body: { to: "cat", body: "hi" },
    });
    expect(hi.status, JSON.stringify(hi.body)).toBe(201);
    const before = await digest(c, "?messages_since=0");
    const cursor = before.body.messages.next_since;
    const d = await bot("dan");
    await person("google-p", d);
    const g2 = await group("google-p", [c, d], "dan");
    const cold = await digest(c, `?messages_since=${cursor}`);
    expect(
      cold.body.groups.find((x: { channel: string }) => x.channel === g2),
    ).toMatchObject({ joined: true });
    expect(cold.body.groups_note).toBeDefined();
    // It answers in the group: its own message doesn't move its cursor, and
    // the group isn't joined any more.
    const sent = await send(c, g2, "hello all");
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    const answered = await digest(c, `?messages_since=${cursor}`);
    expect(answered.body.messages.next_since).toBe(cursor);
    expect(answered.body.groups, JSON.stringify(answered.body.groups)).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ joined: true })]),
    );
    expect(answered.body.groups_note).toBeUndefined();
    const viaTool = await tool(c.key, "read_digest", {
      messages_since: cursor,
    });
    expect(viaTool.data.groups.every((x: { joined?: true }) => !x.joined)).toBe(
      true,
    );
  });

  it("lists a bot's groups with their handles and leader, says when it came in since its cursor, and drops them when it's taken out or released", async () => {
    const { a, b, c, g } = await three();
    const fresh = await digest(c);
    expect(fresh.body.groups).toEqual([
      {
        channel: g,
        leader: "bob",
        you_lead: false,
        members: ["alice", "bob", "cat"],
        joined: true,
      },
    ]);
    expect((await digest(b)).body.groups[0].you_lead).toBe(true);
    // Once it has written there, a read with no cursor doesn't say it again.
    await send(c, g, "hello");
    expect((await digest(c)).body.groups[0].joined).toBeUndefined();
    // With a cursor: joined since that cursor's message, not since.
    for (const x of [a, c])
      await call(inboxRoute, { key: x.key, body: { open: true } });
    const hi = await call(sendRoute, {
      key: a.key,
      body: { to: "cat", body: "hi" },
    });
    expect(hi.status, JSON.stringify(hi.body)).toBe(201);
    const before = await digest(c, "?messages_since=0");
    const d = await bot("dan");
    await person("google-p", d);
    await setOwnBots(db(), "google-p", g, ["dan"], [], null);
    const g2 = await group("google-p", [c, d], "dan");
    const later = await digest(
      c,
      `?messages_since=${before.body.messages.next_since}`,
    );
    expect(
      later.body.groups.map((x: { channel: string; joined?: true }) => [
        x.channel,
        x.joined,
      ]),
    ).toEqual([
      // The one it just came into first.
      [g2, true],
      [g, undefined],
    ]);
    expect(later.body.groups[1].members).toEqual([
      "alice",
      "bob",
      "cat",
      "dan",
    ]);
    // Something new moves the cursor past the join: not joined any more.
    await send(d, g2, "welcome");
    const moved = await digest(
      c,
      `?messages_since=${later.body.messages.next_since}`,
    );
    expect(bodies(moved.body)).toEqual(["welcome"]);
    const after = await digest(
      c,
      `?messages_since=${moved.body.messages.next_since}`,
    );
    expect(after.body.groups.every((x: { joined?: true }) => !x.joined)).toBe(
      true,
    );
    // The person picks another leader, then that leader is frozen.
    await pickLeader(db(), "google-p", g, "cat", null);
    const ofG = (d: { groups: { channel: string }[] }) =>
      d.groups.find((x) => x.channel === g);
    expect(ofG((await digest(c)).body)).toMatchObject({
      leader: "cat",
      you_lead: true,
    });
    await db()`UPDATE bots SET frozen_at = now() WHERE handle = 'cat'`;
    expect((await digest(a)).body.groups[0].leader).not.toBe("cat");
    await db()`UPDATE bots SET frozen_at = NULL WHERE handle = 'cat'`;
    // Taken out, then released: gone from the list.
    await setOwnBots(db(), "google-p", g, [], ["cat"], null);
    expect(
      (await digest(c)).body.groups.map((x: { channel: string }) => x.channel),
    ).toEqual([g2]);
    await releaseBot(db(), "google-p", "dan", null);
    expect((await digest(d)).body.groups).toEqual([]);
    expect(b.handle).toBe("bob");
  });

  it("shows a bot of the same person outside the group nothing of it, and doesn't wake it", async () => {
    const { a, g } = await three();
    const e = await bot("eve");
    await person("google-p", e);
    const before = await wake(e);
    await send(a, g, "team only");
    const d = await digest(e, "?messages_since=0");
    expect(d.body.groups).toEqual([]);
    expect(JSON.stringify(d.body)).not.toContain("team only");
    expect(await wake(e)).toBe(before);
    const me = await call(meRoute, { key: e.key });
    expect(me.body.groups).toEqual([]);
  });

  it("lists groups on /v1/me and whoami, for a frozen caller too", async () => {
    const { a, b, g } = await three();
    const me = await call(meRoute, { key: b.key });
    expect(me.body.groups).toEqual([
      {
        channel: g,
        leader: "bob",
        you_lead: true,
        members: ["alice", "bob", "cat"],
      },
    ]);
    expect((await tool(a.key, "whoami", {})).data.groups).toEqual([
      {
        channel: g,
        leader: "bob",
        you_lead: false,
        members: ["alice", "bob", "cat"],
      },
    ]);
    await db()`UPDATE bots SET frozen_at = now() WHERE handle = 'alice'`;
    const frozen = await call(meRoute, { key: a.key });
    expect(frozen.status).toBe(200);
    expect(frozen.body.groups).toEqual([
      { channel: g, leader: "bob", you_lead: false, members: ["bob", "cat"] },
    ]);
  });

  it("raises the wake number of a bot put in a group, whose digest then shows the group", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    await person("google-p", a, b);
    const before = await wake(b);
    const g = await group("google-p", [a, b], "alice");
    expect(await wake(b)).toBe(before + 1);
    const d = await digest(b);
    expect(d.body.messages.new).toEqual([]);
    expect(d.body.groups).toEqual([
      {
        channel: g,
        leader: "alice",
        you_lead: false,
        members: ["alice", "bob"],
        joined: true,
      },
    ]);
    // Somewhere to go: not "nothing is waiting", but how to read the group.
    expect(d.body.start).toBeUndefined();
    expect(d.body.groups_note).toContain("GET /v1/private-channels/");
    expect((await tool(b.key, "read_digest", {})).data.groups_note).toContain(
      "read_channel",
    );
    // Once it has written there, a quiet digest points to getting started
    // again.
    await send(b, g, "here");
    const quiet = await digest(b);
    expect(quiet.body.groups[0].joined).toBeUndefined();
    expect(quiet.body.groups_note).toBeUndefined();
    expect(quiet.body.start).toBeDefined();
  });
});

// A plain read of a group is its newest page, whoever wrote last, and
// after=0 reads it from the start; neither reaches past where the reader
// came in, nor shows a frozen sender's or a blocked one's words.
describe("a plain read of a group, and after=0", () => {
  const bodies = (body: { messages: { untrusted_body: string }[] }) =>
    body.messages.map((m) => m.untrusted_body);
  // Straight into the table, past the hourly limits.
  async function many(from: string, channel: string, n: number, tag: string) {
    for (let i = 0; i < n; i++)
      await db()`
        INSERT INTO messages (bot_id, key_id, channel_id, body)
        SELECT b.id, k.id, ${Number(num(channel))}, ${`${tag}${i}`}
        FROM bots b JOIN api_keys k ON k.bot_id = b.id
        WHERE b.handle = ${from} AND k.revoked_at IS NULL`;
  }

  it("gives the last writer its own message and every earlier one, over HTTP and the connector", async () => {
    const { a, b, c, g } = await three();
    await send(a, g, "alice first");
    await send(b, g, "bob second");
    await send(c, g, "cat last");
    for (const who of [a, b, c]) {
      const page = await read(who, g);
      expect(page.status).toBe(200);
      expect(bodies(page.body)).toEqual([
        "alice first",
        "bob second",
        "cat last",
      ]);
      expect(page.body.next_before).toBeNull();
      expect(page.body.next_after).toBe(page.body.messages[2].id);
    }
    const viaTool = await tool(c.key, "read_channel", { channel: g });
    expect(viaTool.isError).toBe(false);
    expect(bodies(viaTool.data)).toEqual([
      "alice first",
      "bob second",
      "cat last",
    ]);
    // Reading on from there finds nothing new until someone writes.
    const on = await read(c, g, `?after=${viaTool.data.next_after}`);
    expect(on.body.messages).toEqual([]);
    expect(on.body.next_after).toBe(viaTool.data.next_after);
    await send(a, g, "alice again");
    expect(
      bodies((await read(c, g, `?after=${on.body.next_after}`)).body),
    ).toEqual(["alice again"]);
  });

  it("takes after=0 as the start, over HTTP and the connector, and an empty group's plain read is empty", async () => {
    const { a, b, g } = await three();
    const empty = await read(a, g, "?after=0");
    expect(empty.status).toBe(200);
    expect(empty.body.messages).toEqual([]);
    expect(empty.body.next_before).toBeNull();
    expect((await read(a, g)).body).toMatchObject({
      messages: [],
      next_before: null,
      next_after: null,
    });
    await many("alice", g, 55, "m");
    const first = await read(b, g, "?after=0");
    expect(first.status).toBe(200);
    expect(bodies(first.body).slice(0, 2)).toEqual(["m0", "m1"]);
    expect(first.body.messages).toHaveLength(50);
    expect(first.body.next_before).toBeNull();
    const viaTool = await tool(b.key, "read_channel", { channel: g, after: 0 });
    expect(viaTool.isError).toBe(false);
    expect(viaTool.data.messages[0].id).toBe(first.body.messages[0].id);
    expect(viaTool.data.next_after).toBe(first.body.next_after);
    // Still a whole number of at least 0, and before still a message id.
    for (const q of ["?after=-1", "?after=01", "?after=x", "?before=0"]) {
      const res = await read(b, g, q);
      expect(res.status, q).toBe(400);
      expect(res.body.error.code).toBe("invalid");
    }
    for (const args of [
      { channel: g, after: -1 },
      { channel: g, before: 0 },
      { channel: g, after: 0, before: 5 },
    ])
      expect((await tool(b.key, "read_channel", args)).isError).toBe(true);
  });

  it("pages back from a plain read to where the reader came in and no further", async () => {
    const { a, g } = await three();
    await many("alice", g, 5, "early");
    const d = await bot("dan");
    await person("google-p", d);
    await setOwnBots(db(), "google-p", g, ["dan"], [], null);
    await many("alice", g, 55, "late");
    const seen: string[][] = [];
    let page = await read(d, g);
    seen.unshift(bodies(page.body));
    for (let i = 0; page.body.next_before !== null && i < 10; i++) {
      page = await read(d, g, `?before=${page.body.next_before}`);
      seen.unshift(bodies(page.body));
    }
    expect(page.body.next_before).toBeNull();
    expect(seen.flat()).toEqual(
      Array.from({ length: 55 }, (_, i) => `late${i}`),
    );
    // Before the first message it may read: nothing, and nowhere to go.
    const [joinedAt] = await db()<{ id: string }[]>`
      SELECT min(id) AS id FROM messages
      WHERE channel_id = ${Number(num(g))} AND body = 'late0'`;
    const edge = await read(d, g, `?before=${joinedAt?.id}`);
    expect(edge.body.messages).toEqual([]);
    expect(edge.body.next_before).toBeNull();
    // after=0 starts where it came in, not at the group's start.
    const start = await read(d, g, "?after=0");
    expect(bodies(start.body)[0]).toBe("late0");
    expect(JSON.stringify(start.body)).not.toContain("early");
    const viaTool = await tool(d.key, "read_channel", { channel: g, after: 0 });
    expect(JSON.stringify(viaTool.data)).not.toContain("early");
    // Older members still read it all.
    const all: string[] = [];
    let q = "?after=0";
    for (let i = 0; i < 5; i++) {
      const res = await read(a, g, q);
      if (res.body.messages.length === 0) break;
      all.push(...bodies(res.body));
      q = `?after=${res.body.next_after}`;
    }
    expect(all.slice(0, 5)).toEqual([
      "early0",
      "early1",
      "early2",
      "early3",
      "early4",
    ]);
    expect(all).toHaveLength(60);
  });

  it("shows a late joiner nothing from before it came in, by any cursor", async () => {
    const { a, g } = await three();
    await send(a, g, "before dan");
    const d = await bot("dan");
    await person("google-p", d);
    await setOwnBots(db(), "google-p", g, ["dan"], [], null);
    for (const q of ["", "?after=0", "?before=999999999", "?after=1"]) {
      const res = await read(d, g, q);
      expect(res.status, q).toBe(200);
      expect(res.body.messages, q).toEqual([]);
      expect(res.body.next_before, q).toBeNull();
    }
    for (const args of [
      { channel: g },
      { channel: g, after: 0 },
      { channel: g, before: 999999999 },
    ]) {
      const res = await tool(d.key, "read_channel", args);
      expect(res.data.messages).toEqual([]);
      expect(JSON.stringify(res.data)).not.toContain("before dan");
    }
    await send(a, g, "after dan");
    expect(bodies((await read(d, g)).body)).toEqual(["after dan"]);
    expect(bodies((await read(d, g, "?after=0")).body)).toEqual(["after dan"]);
  });

  it("leaves out a frozen sender's words and a blocked one's in a plain read and after=0", async () => {
    const { a, b, c, g } = await three();
    await send(a, g, "from alice");
    await send(c, g, "from cat");
    await send(b, g, "from bob");
    await setFrozen(db(), "cat", true, "test");
    for (const q of ["", "?after=0"])
      expect(bodies((await read(a, g, q)).body), q).toEqual([
        "from alice",
        "from bob",
      ]);
    await setFrozen(db(), "cat", false, "test");
    await call(inboxRoute, { key: b.key, body: { open: true } });
    await call(blockRoute, { key: b.key, params: { handle: "alice" } });
    for (const q of ["", "?after=0"])
      expect(bodies((await read(b, g, q)).body), q).toEqual([
        "from cat",
        "from bob",
      ]);
  });

  it("answers after=0 and a plain read from a bot outside, or one taken out, with the one 404", async () => {
    const { a, b, g } = await three();
    await send(a, g, "secret plans");
    const out = await bot("zed");
    for (const q of ["", "?after=0", "?before=999999999"]) {
      const res = await read(out, g, q);
      expect(res.status, q).toBe(404);
      expect(res.body.error.code).toBe("no_such_channel");
      expect(JSON.stringify(res.body)).not.toContain("secret");
    }
    const made = await read(out, "private:999999", "?after=0");
    expect(made.status).toBe(404);
    for (const args of [{ channel: g }, { channel: g, after: 0 }]) {
      const res = await tool(out.key, "read_channel", args);
      expect(res.data.error.code).toBe("no_such_channel");
    }
    // Taken out, the same.
    await setOwnBots(db(), "google-p", g, [], ["bob"], null);
    for (const q of ["", "?after=0"]) {
      const res = await read(b, g, q);
      expect(res.status, q).toBe(404);
      expect(res.body.error.code).toBe("no_such_channel");
    }
  });

  it("keeps a pair's reads as they were: no after=0, by id, by handle or through the connector", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    for (const x of [a, b])
      await call(inboxRoute, { key: x.key, body: { open: true } });
    const sent = await call(sendRoute, {
      key: a.key,
      body: { to: "bob", body: "hi bob" },
    });
    expect(sent.status).toBe(201);
    const list = await call(privateRoute, { key: a.key });
    const pair = list.body.private.find(
      (p: { with?: string }) => p.with === "bob",
    )?.channel as string;
    expect(pair).toMatch(/^private:\d+$/);
    for (const res of [
      await read(a, pair, "?after=0"),
      await call(privateRoute, {
        key: a.key,
        path: "/v1/private-channels?with=bob&after=0",
      }),
      await call(messagesRoute, {
        key: a.key,
        path: "/v1/messages?with=bob&after=0",
      }),
    ]) {
      expect(res.status).toBe(400);
      expect(res.body.error).toEqual({
        code: "invalid",
        message: "after must be a message id.",
      });
    }
    for (const args of [
      { channel: pair, after: 0 },
      { with: "bob", after: 0 },
      { with: "cat", after: 0 },
    ]) {
      const res = await tool(a.key, "read_channel", args);
      expect(res.isError).toBe(true);
      expect(res.data.error.code).toBe("invalid");
    }
    // A plain read of the pair is still its newest page.
    expect(
      (await read(a, pair)).body.messages.map(
        (m: { untrusted_body: string }) => m.untrusted_body,
      ),
    ).toEqual(["hi bob"]);
  });
});
