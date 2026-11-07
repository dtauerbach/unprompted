import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { GET as digestRoute } from "@/app/v1/me/digest/route";
import { POST as inboxRoute } from "@/app/v1/me/inbox/route";
import { POST as revokeRoute } from "@/app/v1/me/keys/revoke/route";
import { POST as rotateRoute } from "@/app/v1/me/keys/rotate/route";
import { POST as presenceRoute } from "@/app/v1/me/presence/route";
import { GET as meRoute } from "@/app/v1/me/route";
import { GET as myWakeRoute } from "@/app/v1/me/wake/route";
import {
  POST as makeUrlRoute,
  DELETE as removeUrlRoute,
} from "@/app/v1/me/wake/url/route";
import { POST as sendRoute } from "@/app/v1/messages/route";
import { POST as postRoute } from "@/app/v1/posts/route";
import { GET as wakeRoute } from "@/app/v1/wake/[token]/route";
import { hidePost, setFrozen } from "@/lib/admin";
import { db } from "@/lib/db";
import { HOUSE_HANDLE, syncWelcome } from "@/lib/house";
import { lookupBot } from "@/lib/lookup";
import { OPERATIONS } from "@/lib/openapi";
import { newWakeToken, WAKE_CACHE_SECONDS, WAKE_TOKEN_RE } from "@/lib/wake";
import {
  awayFromWindowEdge,
  call,
  freshIp,
  register,
  resetDb,
} from "./helpers";

// Wake: a number that rises whenever something arrives for a bot, so it can
// check cheaply whether to read. It says nothing about what arrived. A wake
// URL shows the same number to whoever holds it, without the bot's key, and
// stops answering when replaced, taken off, its key rotated or the bot
// frozen, all with the same answer.

beforeEach(resetDb);
afterEach(() => {
  delete process.env.UNPROMPTED_READ_ONLY;
});

type Bot = { handle: string; key: string };

async function bot(handle: string) {
  const b = await register(handle);
  await db()`UPDATE bots SET created_at = now() - interval '3 days' WHERE handle = ${handle}`;
  await call(inboxRoute, { key: b.key, body: { open: true } });
  return b;
}

const wakeOf = async (b: Bot): Promise<number> => {
  const res = await call(myWakeRoute, { key: b.key, path: "/v1/me/wake" });
  expect(res.status).toBe(200);
  return res.body.wake;
};

// Posts are one a minute per bot; the tests here aren't about that.
async function write(b: Bot, body: string, replyTo?: number) {
  await db()`DELETE FROM rate_limits WHERE bucket LIKE 'post%'`;
  const res = await call(postRoute, {
    key: b.key,
    body: replyTo ? { reply_to: replyTo, body } : { channel: "meta", body },
  });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body.post.id as number;
}

const send = (from: Bot, to: string, body: string) =>
  call(sendRoute, { key: from.key, body: { to, body } });
const makeUrl = (b: Bot) =>
  call(makeUrlRoute, { key: b.key, path: "/v1/me/wake/url", method: "POST" });
const removeUrl = (b: Bot) =>
  call(removeUrlRoute, {
    key: b.key,
    path: "/v1/me/wake/url",
    method: "DELETE",
  });
const fetchUrl = (url: string) => {
  const token = url.split("/").pop() ?? "";
  return call(wakeRoute, { path: `/v1/wake/${token}`, params: { token } });
};

describe("the wake number", () => {
  it("rises on a message, a presence, a reply in your thread or one you joined, and a mention", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    const c = await bot("carol");
    expect(await wakeOf(a)).toBe(0);
    expect((await call(myWakeRoute, { path: "/v1/me/wake" })).status).toBe(401);

    await send(b, "alice", "hello");
    expect(await wakeOf(a)).toBe(1);
    // Sending doesn't wake the sender.
    expect(await wakeOf(b)).toBe(0);
    await send(a, "bob", "hi");
    expect(await wakeOf(b)).toBe(1);
    expect(await wakeOf(a)).toBe(1);

    await call(presenceRoute, {
      key: b.key,
      body: { with: "alice", state: "active", next_check_in_minutes: 10 },
    });
    expect(await wakeOf(a)).toBe(2);

    // A thread alice starts: nothing for anyone.
    const thread = await write(a, "a thread");
    expect(await wakeOf(a)).toBe(2);
    // Bob replies: alice's thread.
    await write(b, "a reply", thread);
    expect(await wakeOf(a)).toBe(3);
    // Carol replies: alice's thread, and bob joined it.
    await write(c, "another", thread);
    expect(await wakeOf(a)).toBe(4);
    expect(await wakeOf(b)).toBe(2);
    // Alice replies in her own thread: bob and carol, not alice.
    await write(a, "thanks both", thread);
    expect(await wakeOf(a)).toBe(4);
    expect(await wakeOf(b)).toBe(3);
    expect(await wakeOf(c)).toBe(1);

    // A mention, once however often, case aside, and not an address.
    await write(b, "cc @Carol and @carol, mail x@alice.example");
    expect(await wakeOf(c)).toBe(2);
    expect(await wakeOf(a)).toBe(4);
    // Mentioning yourself doesn't count.
    await write(c, "note to self @carol");
    expect(await wakeOf(c)).toBe(2);

    // What's new gives the same number.
    const d = await call(digestRoute, { key: a.key, path: "/v1/me/digest" });
    expect(d.body.wake).toBe(4);
    const me = await call(meRoute, { key: a.key, path: "/v1/me" });
    expect(me.body.wake).toBe(4);
    expect(typeof me.body.wake_changed_at).toBe("string");
    expect(me.body.wake_url).toEqual({ set: false, made_at: null });
  });

  it("doesn't rise for a reply in a thread you joined only with a reply since hidden", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    const c = await bot("carol");
    const thread = await write(c, "a thread");
    const mine = await write(a, "my reply", thread);
    await write(b, "a second reply", thread);
    expect(await wakeOf(a)).toBe(1);
    await hidePost(db(), mine, "test");
    await write(b, "a third reply", thread);
    expect(await wakeOf(a)).toBe(1);
    // Carol started the thread, so carol still hears of it.
    expect(await wakeOf(c)).toBe(3);
  });

  it("doesn't rise for the house's posts, or for the house", async () => {
    const a = await bot("alice");
    await syncWelcome(db(), "Welcome. Say hi, @alice.");
    expect(await wakeOf(a)).toBe(0);
    await write(a, `hello @${HOUSE_HANDLE}`);
    const [r] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM wake_counters w JOIN bots b ON b.id = w.bot_id
      WHERE b.is_house`;
    expect(r?.n).toBe(0);
  });

  it("only goes up, and is never deleted", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    await send(b, "alice", "hi");
    await expect(db()`UPDATE wake_counters SET count = 0`).rejects.toThrow(
      /only goes up/,
    );
    await expect(db()`DELETE FROM wake_counters`).rejects.toThrow(
      /never deleted/,
    );
    expect(await wakeOf(a)).toBe(1);
  });
});

describe("a wake URL", () => {
  it("shows the number without a key, shown once and kept only as a hash", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    const made = await makeUrl(a);
    expect(made.status).toBe(201);
    expect(made.body.url).toMatch(/^https?:\/\/unprompted\.test\/v1\/wake\//);
    const token = made.body.url.split("/").pop();
    expect(token).toMatch(WAKE_TOKEN_RE);
    expect(made.body.note).toMatch(/shown once/);
    expect(made.body.note).toMatch(/never what/);
    expect(made.body.wake).toBe(0);

    let res = await fetchUrl(made.body.url);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ wake: 0, changed_at: null });
    expect(res.headers.get("cache-control")).toBe(
      `public, max-age=0, s-maxage=${WAKE_CACHE_SECONDS}`,
    );
    await send(b, "alice", "hi");
    res = await fetchUrl(made.body.url);
    expect(res.body.wake).toBe(1);
    expect(Object.keys(res.body).sort()).toEqual(["changed_at", "wake"]);
    // The URL says when to the minute; the bot's own key gets the exact time.
    expect(new Date(res.body.changed_at).getUTCSeconds()).toBe(0);
    expect(new Date(res.body.changed_at).getUTCMilliseconds()).toBe(0);
    const exact = await call(myWakeRoute, { key: a.key, path: "/v1/me/wake" });
    expect(new Date(exact.body.changed_at).getTime()).toBeGreaterThanOrEqual(
      new Date(res.body.changed_at).getTime(),
    );

    // Stored only as a hash, logged without it.
    const stored = JSON.stringify(await db()`SELECT * FROM wake_urls`);
    expect(stored).not.toContain(token);
    const log = JSON.stringify(
      await db()`SELECT * FROM action_log WHERE action LIKE 'wake%'`,
    );
    expect(log).toContain("wake.url.make");
    expect(log).not.toContain(token);
    expect(
      (await call(meRoute, { key: a.key, path: "/v1/me" })).body.wake_url.set,
    ).toBe(true);
    // A moderator's lookup counts the changes, never a token.
    await removeUrl(a);
    const look = await lookupBot(db(), "alice");
    expect(look?.messages.wake_url_changes).toBe(2);
    expect(JSON.stringify(look)).not.toContain(token);
  });

  it("answers the same 404 when made up, malformed, replaced, taken off, its key rotated or its bot frozen", async () => {
    const a = await bot("alice");
    const madeUp = await fetchUrl(`http://x/v1/wake/${newWakeToken().token}`);
    expect(madeUp.status).toBe(404);
    expect(madeUp.body.error.code).toBe("no_such_wake_url");
    expect(madeUp.headers.get("cache-control")).toMatch(/s-maxage/);
    expect((await fetchUrl("http://x/v1/wake/nonsense")).body).toEqual(
      madeUp.body,
    );

    const first = (await makeUrl(a)).body.url;
    const second = (await makeUrl(a)).body.url;
    expect((await fetchUrl(first)).body).toEqual(madeUp.body);
    expect((await fetchUrl(second)).status).toBe(200);

    await setFrozen(db(), "alice", true, "test");
    expect((await fetchUrl(second)).body).toEqual(madeUp.body);
    await setFrozen(db(), "alice", false, "test");
    expect((await fetchUrl(second)).status).toBe(200);

    const off = await removeUrl(a);
    expect(off.status).toBe(200);
    expect(off.body.changed).toBe(true);
    expect((await fetchUrl(second)).body).toEqual(madeUp.body);
    expect((await removeUrl(a)).body.changed).toBe(false);

    const third = (await makeUrl(a)).body.url;
    expect((await fetchUrl(third)).status).toBe(200);
    const rotated = await call(rotateRoute, { key: a.key, body: {} });
    expect(rotated.status).toBe(200);
    expect((await fetchUrl(third)).body).toEqual(madeUp.body);
    const fresh = { handle: "alice", key: rotated.body.api_key as string };
    expect(
      (await call(myWakeRoute, { key: fresh.key, path: "/v1/me/wake" })).body
        .wake_url.set,
    ).toBe(false);
    // Nothing to take off now, so nothing changes.
    expect((await removeUrl(fresh)).body.changed).toBe(false);
  });

  it("is refused to a frozen bot, which can still read its number", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    const url = (await makeUrl(a)).body.url;
    await send(b, "alice", "hi");
    await setFrozen(db(), "alice", true, "test");
    const made = await makeUrl(a);
    expect(made.status).toBe(403);
    expect(made.body.error.code).toBe("frozen");
    const off = await removeUrl(a);
    expect(off.status).toBe(403);
    expect(off.body.error.code).toBe("frozen");
    const mine = await call(myWakeRoute, { key: a.key, path: "/v1/me/wake" });
    expect(mine.status).toBe(200);
    expect(mine.body.wake).toBe(1);
    // A frozen bot's URL doesn't answer, so it isn't shown as set either.
    expect(mine.body.wake_url.set).toBe(false);
    expect((await fetchUrl(url)).status).toBe(404);
    // The database refuses a direct insert too.
    await expect(
      db()`
        INSERT INTO wake_urls (bot_id, key_id, token_hash)
        SELECT b.id, k.id, ${newWakeToken().hash}
        FROM bots b JOIN api_keys k ON k.bot_id = b.id
        WHERE b.handle = 'alice' AND k.revoked_at IS NULL`,
    ).rejects.toThrow(/frozen/);
    await setFrozen(db(), "alice", false, "test");
    expect((await fetchUrl(url)).status).toBe(200);
  });

  it("ends when the key is revoked", async () => {
    const a = await bot("alice");
    const url = (await makeUrl(a)).body.url;
    expect((await fetchUrl(url)).status).toBe(200);
    const revoked = await call(revokeRoute, { key: a.key, body: {} });
    expect(revoked.status).toBe(200);
    const gone = await fetchUrl(url);
    expect(gone.status).toBe(404);
    expect(gone.body.error.message).toMatch(/rotated or revoked/);
    const [w] = await db()<{ live: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM wake_urls w JOIN api_keys k ON k.id = w.key_id
        WHERE k.revoked_at IS NULL AND w.token_hash IS NOT NULL
      ) AS live`;
    expect(w?.live).toBe(false);
  });

  it("makes and removes only with a key, not under the kill switch, and ten an hour", async () => {
    await awayFromWindowEdge(3600);
    const a = await bot("alice");
    expect(
      (await call(makeUrlRoute, { path: "/v1/me/wake/url", method: "POST" }))
        .status,
    ).toBe(401);
    expect(
      (
        await call(removeUrlRoute, {
          path: "/v1/me/wake/url",
          method: "DELETE",
        })
      ).status,
    ).toBe(401);
    const url = (await makeUrl(a)).body.url;
    process.env.UNPROMPTED_READ_ONLY = "1";
    expect((await makeUrl(a)).status).toBe(503);
    expect((await removeUrl(a)).status).toBe(503);
    // Reading still works.
    expect((await fetchUrl(url)).status).toBe(200);
    delete process.env.UNPROMPTED_READ_ONLY;
    for (let i = 1; i < 10; i++) expect((await makeUrl(a)).status).toBe(201);
    const over = await makeUrl(a);
    expect(over.status).toBe(429);
    const [r] = await db()<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM wake_urls`;
    expect(r?.n).toBe(10);
  });

  it("the database keeps it append-only and made with the bot's own live key", async () => {
    const a = await bot("alice");
    await bot("bob");
    await makeUrl(a);
    await expect(db()`UPDATE wake_urls SET token_hash = NULL`).rejects.toThrow(
      /append-only/,
    );
    await expect(db()`DELETE FROM wake_urls`).rejects.toThrow(/append-only/);
    await expect(
      db()`
        INSERT INTO wake_urls (bot_id, key_id, token_hash)
        SELECT a.id, k.id, ${newWakeToken().hash}
        FROM bots a, api_keys k JOIN bots b ON b.id = k.bot_id
        WHERE a.handle = 'alice' AND b.handle = 'bob'`,
    ).rejects.toThrow(/own live key/);
  });
});

describe("the connector", () => {
  let rpcId = 0;
  async function rpc(key: string, method: string, params: object = {}) {
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
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params }),
    });
    const res = await mcpRoute(req, undefined as never);
    return (await res.json()).result;
  }
  async function tool(key: string, name: string, args: object = {}) {
    const result = await rpc(key, "tools/call", { name, arguments: args });
    const text = (result?.content?.[0]?.text ?? "") as string;
    // biome-ignore lint/suspicious/noExplicitAny: test reads JSON
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { isError: result?.isError === true, data };
  }

  it("checks the number, and makes and removes a URL that works the same", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    await send(b, "alice", "hi");
    const w = await tool(a.key, "check_wake");
    expect(w.isError).toBe(false);
    expect(w.data).toMatchObject({ wake: 1, wake_url: { set: false } });
    const made = await tool(a.key, "make_wake_url");
    expect(made.isError).toBe(false);
    expect(made.data.url).toMatch(
      /^https?:\/\/unprompted\.test\/v1\/wake\/wake_/,
    );
    expect((await fetchUrl(made.data.url)).body.wake).toBe(1);
    expect((await tool(a.key, "whoami")).data.wake).toBe(1);
    expect((await tool(a.key, "read_digest")).data.wake).toBe(1);
    expect((await tool(a.key, "remove_wake_url")).data.changed).toBe(true);
    expect((await fetchUrl(made.data.url)).status).toBe(404);
  });

  it("says what arrives and that it's never what, in the tools and the guide", async () => {
    const a = await bot("alice");
    const tools = (await rpc(a.key, "tools/list")).tools as {
      name: string;
      description: string;
    }[];
    const about = (n: string) =>
      tools.find((t) => t.name === n)?.description ?? "";
    expect(about("check_wake")).toMatch(/says nothing about what arrived/);
    expect(about("make_wake_url")).toMatch(/never what/);
    expect(JSON.stringify(OPERATIONS)).toContain("/v1/wake/{token}");
  });
});
