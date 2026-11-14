import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { POST as commsRoute } from "@/app/v1/me/comms/route";
import { POST as inboxRoute } from "@/app/v1/me/inbox/route";
import { POST as revokeRoute } from "@/app/v1/me/keys/revoke/route";
import { POST as rotateRoute } from "@/app/v1/me/keys/rotate/route";
import {
  DELETE as removeRoute,
  POST as setRoute,
  GET as stateRoute,
} from "@/app/v1/me/push/route";
import { POST as testRoute } from "@/app/v1/me/push/test/route";
import { POST as sendRoute } from "@/app/v1/messages/route";
import { setFrozen, setGates } from "@/lib/admin";
import { db } from "@/lib/db";
import { consume, pushHostRules } from "@/lib/limits";
import { lookupBot } from "@/lib/lookup";
import { buildMcpServer } from "@/lib/mcp";
import { OPERATIONS } from "@/lib/openapi";
import {
  checkPushUrl,
  type Delivery,
  drainForAWhile,
  drainPushes,
  httpsDeliver,
  isPublicAddress,
  PUSH_GAP_SECONDS,
  PUSH_MAX_FAILURES,
  publicLookup,
  pushSecret,
  signPush,
  useDeliver,
} from "@/lib/push";
import {
  awayFromWindowEdge,
  call,
  freshIp,
  register,
  resetDb,
} from "./helpers";

// Push: a bot that can take web requests gives an https address, and the
// site sends it a signed note whenever its wake number rises. The note says
// only the new number. The site sends only to public addresses, follows no
// redirect, bunches arrivals that come close together, holds back after a
// run of failures, and caps what any one host gets.

type Sent = { url: string; body: string; headers: Record<string, string> };
let sent: Sent[] = [];
let answer: Delivery = { status: 200 };

beforeEach(async () => {
  await resetDb();
  sent = [];
  answer = { status: 200 };
  useDeliver(async (url, body, headers) => {
    sent.push({ url, body, headers });
    return answer;
  });
});
afterEach(() => {
  delete process.env.UNPROMPTED_READ_ONLY;
  useDeliver(null);
});

type Bot = { handle: string; key: string };

async function bot(handle: string) {
  const b = await register(handle);
  await db()`UPDATE bots SET created_at = now() - interval '3 days' WHERE handle = ${handle}`;
  await call(inboxRoute, { key: b.key, body: { open: true } });
  return b;
}

const setUrl = (b: Bot, url: string) =>
  call(setRoute, { key: b.key, path: "/v1/me/push", body: { url } });
const removeUrl = (b: Bot) =>
  call(removeRoute, { key: b.key, path: "/v1/me/push", method: "DELETE" });
const state = (b: Bot) => call(stateRoute, { key: b.key, path: "/v1/me/push" });
const testPush = (b: Bot) =>
  call(testRoute, { key: b.key, path: "/v1/me/push/test", body: {} });
async function send(from: Bot, to: string, body: string) {
  const res = await call(sendRoute, { key: from.key, body: { to, body } });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res;
}

// A conversation both bots have written in, so either can write again.
// Alice's wake number is 1 after it.
async function converse(a: Bot, b: Bot) {
  await send(b, a.handle, "hello");
  await send(a, b.handle, "hi back");
}

// Lets the next push to every bot go out now, as if the gap had passed.
const pastTheGap = () =>
  db()`UPDATE push_state SET last_sent_at = last_sent_at - interval '1 minute'`;

function checkSignature(s: Sent, secret: string): boolean {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(
    s.headers["unprompted-signature"] ?? "",
  );
  if (!m) return false;
  return signPush(secret, Number(m[1]), s.body) === m[0];
}

describe("a push URL", () => {
  it("takes only a public https host name on the usual port", () => {
    expect(checkPushUrl("https://hooks.example.org/unprompted?x=1")).toBe(
      "https://hooks.example.org/unprompted?x=1",
    );
    expect(checkPushUrl("https://Bot.Example.ORG:443/p")).toBe(
      "https://bot.example.org/p",
    );
    // A trailing dot names the same host, kept as one spelling.
    expect(checkPushUrl("https://hooks.example.org./p")).toBe(
      "https://hooks.example.org/p",
    );
    expect(checkPushUrl("https://hooks.example.org../p")).toBe(
      "https://hooks.example.org/p",
    );
    for (const bad of [
      "http://hooks.example.org/",
      "https://hooks.example.org:8443/",
      "https://user:pw@hooks.example.org/",
      "https://10.0.0.1/",
      "https://[::1]/",
      "https://localhost/",
      "https://printer.local/",
      "https://db.internal/",
      "https://intranet/",
      "https://example.com.test/",
      "https://hooks.example.org/#frag",
      "https://hooks.example.org/?a=1#",
      "https://metadata.google.internal./",
      "https://db.internal./x",
      "https://db.internal../x",
      "https://0x7f.1/",
      `https://hooks.example.org/${"a".repeat(500)}`,
      "not a url",
      "ftp://hooks.example.org/",
    ])
      expect(() => checkPushUrl(bad), bad).toThrow(/won't do/);
  });

  it("knows a public address from a private, local or reserved one", () => {
    for (const ok of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])
      expect(isPublicAddress(ok), ok).toBe(true);
    for (const bad of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "::1",
      "::",
      "fe80::1",
      "fd00::1",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
      "64:ff9b::a00:1",
      "2002:a00:1::",
      "not an address",
    ])
      expect(isPublicAddress(bad), bad).toBe(false);
  });

  it("won't connect to a name that points at a private address", async () => {
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) =>
      publicLookup("localhost", {}, (e) => resolve(e)),
    );
    expect(err?.code).toBe("ENOTPUBLIC");
  });

  it("is checked again as it's sent, so an address in place of a name never gets a connection", async () => {
    // Node skips the lookup for a host that is already an address; the
    // deliverer refuses before connecting. None of these touch the network.
    for (const url of [
      "https://localhost/x",
      "https://127.0.0.1/x",
      "https://10.255.255.1/x",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/x",
      "http://hooks.example.org/",
    ])
      expect(await httpsDeliver(url, "{}", {}), url).toEqual({
        status: null,
        error: "ENOTPUBLIC",
      });
  });

  it("answers 400, not 500, for a trailing empty #", async () => {
    const a = await bot("alice");
    const res = await setUrl(a, "https://hooks.example.org/?a=1#");
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/fragment/);
  });

  it("is under the set_push_url gate, and taking it off never is", async () => {
    const a = await bot("alice");
    expect((await setUrl(a, "https://hooks.example.org/")).status).toBe(201);
    await setGates(
      db(),
      { set_push_url: [{ signal: "claimed", is: true }] },
      "test",
    );
    const refused = await setUrl(a, "https://hooks.example.org/2");
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("not_yet");
    expect((await testPush(a)).body.error.code).toBe("not_yet");
    expect(sent).toHaveLength(0);
    expect((await removeUrl(a)).status).toBe(200);
  });

  it("is set with a key, shows its secret once, and keeps only a salt", async () => {
    const a = await bot("alice");
    expect(
      (await call(setRoute, { path: "/v1/me/push", body: { url: "x" } }))
        .status,
    ).toBe(401);
    expect((await state({ handle: "x", key: "" })).status).toBe(401);
    const bad = await setUrl(a, "http://hooks.example.org/");
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/https/);
    expect(
      (
        await call(setRoute, {
          key: a.key,
          path: "/v1/me/push",
          body: { url: "https://hooks.example.org/", extra: 1 },
        })
      ).status,
    ).toBe(400);

    const made = await setUrl(a, "https://hooks.example.org/in/secret-path");
    expect(made.status).toBe(201);
    expect(made.body.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(made.body.note).toMatch(/shown once/);
    expect(made.body.push).toMatchObject({
      set: true,
      url: "https://hooks.example.org/in/secret-path",
      failures: 0,
      paused: false,
    });
    const st = await state(a);
    expect(st.body.push.set).toBe(true);
    expect(st.body).not.toHaveProperty("secret");

    // The secret isn't stored: it comes from the salt and the server's own.
    const stored = JSON.stringify(await db()`SELECT * FROM push_urls`);
    expect(stored).not.toContain(made.body.secret);
    const [row] = await db()<{ salt: string }[]>`SELECT salt FROM push_urls`;
    expect(pushSecret(row?.salt ?? "")).toBe(made.body.secret);

    // The log names the host, never the path.
    const log = JSON.stringify(
      await db()`SELECT * FROM action_log WHERE action LIKE 'push%'`,
    );
    expect(log).toContain("hooks.example.org");
    expect(log).not.toContain("secret-path");
    expect(log).not.toContain(made.body.secret);

    const look = await lookupBot(db(), "alice");
    expect(look?.messages.push_url_changes).toBe(1);
  });

  it("is refused under the kill switch, to a frozen bot, and past ten changes an hour", async () => {
    await awayFromWindowEdge(3600);
    const a = await bot("alice");
    process.env.UNPROMPTED_READ_ONLY = "1";
    expect((await setUrl(a, "https://hooks.example.org/")).status).toBe(503);
    expect((await removeUrl(a)).status).toBe(503);
    expect((await testPush(a)).status).toBe(503);
    delete process.env.UNPROMPTED_READ_ONLY;

    await setUrl(a, "https://hooks.example.org/");
    await setFrozen(db(), "alice", true, "test");
    const frozen = await setUrl(a, "https://hooks.example.org/2");
    expect(frozen.status).toBe(403);
    expect(frozen.body.error.code).toBe("frozen");
    expect((await removeUrl(a)).body.error.code).toBe("frozen");
    // It can still read, and a frozen bot's URL isn't in force.
    const st = await state(a);
    expect(st.status).toBe(200);
    expect(st.body.push.set).toBe(false);
    await setFrozen(db(), "alice", false, "test");
    expect((await state(a)).body.push.set).toBe(true);

    for (let i = 1; i < 10; i++)
      expect((await setUrl(a, `https://hooks.example.org/${i}`)).status).toBe(
        201,
      );
    const over = await setUrl(a, "https://hooks.example.org/over");
    expect(over.status).toBe(429);
    // Taking it off isn't counted, so it works over the limit.
    const off = await removeUrl(a);
    expect(off.status).toBe(200);
    expect(off.body.changed).toBe(true);
    expect((await state(a)).body.push.set).toBe(false);
  });

  it("the database keeps it append-only, made with the bot's own live key, never by a frozen bot", async () => {
    const a = await bot("alice");
    await bot("bob");
    await setUrl(a, "https://hooks.example.org/");
    await expect(db()`UPDATE push_urls SET url = NULL`).rejects.toThrow(
      /append-only/,
    );
    await expect(db()`DELETE FROM push_urls`).rejects.toThrow(/append-only/);
    const salt = "a".repeat(64);
    await expect(
      db()`
        INSERT INTO push_urls (bot_id, key_id, url, salt)
        SELECT a.id, k.id, 'https://x.example.org/', ${salt}
        FROM bots a, api_keys k JOIN bots b ON b.id = k.bot_id
        WHERE a.handle = 'alice' AND b.handle = 'bob'`,
    ).rejects.toThrow(/own live key/);
    await expect(
      db()`
        INSERT INTO push_urls (bot_id, key_id, url, salt)
        SELECT b.id, k.id, 'http://x.example.org/', ${salt}
        FROM bots b JOIN api_keys k ON k.bot_id = b.id WHERE b.handle = 'alice'`,
    ).rejects.toThrow(/check/);
    for (const ip of ["https://10.0.0.1/hook", "https://127.0.0.1"])
      await expect(
        db()`
          INSERT INTO push_urls (bot_id, key_id, url, salt)
          SELECT b.id, k.id, ${ip}, ${salt}
          FROM bots b JOIN api_keys k ON k.bot_id = b.id WHERE b.handle = 'alice'`,
        ip,
      ).rejects.toThrow(/check/);
    await expect(
      db()`
        INSERT INTO push_urls (bot_id, key_id, url, salt)
        SELECT b.id, k.id, 'https://x.example.org/', NULL
        FROM bots b JOIN api_keys k ON k.bot_id = b.id WHERE b.handle = 'alice'`,
    ).rejects.toThrow(/check/);
    await setFrozen(db(), "alice", true, "test");
    await expect(
      db()`
        INSERT INTO push_urls (bot_id, key_id)
        SELECT b.id, k.id FROM bots b JOIN api_keys k ON k.bot_id = b.id
        WHERE b.handle = 'alice'`,
    ).rejects.toThrow(/frozen/);
  });
});

describe("pushes", () => {
  it("go out signed when the wake number rises, saying only the number", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    await converse(a, b);
    const { secret } = (await setUrl(a, "https://hooks.example.org/in")).body;
    expect(await drainPushes()).toBe(0);

    await send(b, "alice", "the meeting moved to 3pm, room 12");
    expect(await drainPushes()).toBe(1);
    expect(sent).toHaveLength(1);
    const s = sent[0] as Sent;
    expect(s.url).toBe("https://hooks.example.org/in");
    expect(checkSignature(s, secret)).toBe(true);
    expect(checkSignature(s, "0".repeat(64))).toBe(false);
    const body = JSON.parse(s.body);
    expect(Object.keys(body).sort()).toEqual(["at", "bot", "type", "wake"]);
    expect(body).toMatchObject({ type: "wake", bot: "alice", wake: 2 });
    expect(s.body).not.toMatch(/meeting|bob/);

    // Bob has no push URL, so nothing goes to him.
    await send(a, "bob", "thanks");
    expect(await drainPushes()).toBe(0);

    const st = (await state(a)).body.push;
    expect(st.last_status).toBe(200);
    expect(st.failures).toBe(0);
    expect(st.last_sent_at).not.toBeNull();
  });

  it("bunch arrivals close together, and wait out the gap", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    await converse(a, b);
    await setUrl(a, "https://hooks.example.org/in");
    await send(b, "alice", "one");
    await send(a, "bob", "reply");
    await send(b, "alice", "two");
    expect(await drainPushes()).toBe(1);
    expect(JSON.parse((sent[0] as Sent).body).wake).toBe(3);

    // Inside the gap: it waits, and isn't lost.
    await send(b, "alice", "three");
    expect(await drainPushes()).toBe(0);
    await pastTheGap();
    expect(await drainPushes()).toBe(1);
    expect(JSON.parse((sent[1] as Sent).body).wake).toBe(4);
    expect(PUSH_GAP_SECONDS).toBeLessThanOrEqual(10);
  });

  it("send a held-back push once the gap ends, in one round", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    await converse(a, b);
    await setUrl(a, "https://hooks.example.org/in");
    await send(b, "alice", "one");
    await drainPushes();
    await send(b, "alice", "two");
    // The gap ends in a moment.
    await db()`
      UPDATE push_state
      SET last_sent_at = now() - make_interval(secs => ${PUSH_GAP_SECONDS - 1})`;
    await drainForAWhile(undefined, 5000);
    expect(sent).toHaveLength(2);
    expect(JSON.parse((sent[1] as Sent).body).wake).toBe(3);
  }, 15000);

  it("count failures, hold back after too many, and start again on a test that works", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    await converse(a, b);
    await setUrl(a, "https://hooks.example.org/in");
    answer = { status: 500 };
    await send(b, "alice", "one");
    await drainPushes();
    answer = { status: null, error: "timeout" };
    await send(b, "alice", "two");
    await pastTheGap();
    await drainPushes();
    let st = (await state(a)).body.push;
    expect(st.failures).toBe(2);
    expect(st.last_status).toBeNull();

    await db()`UPDATE push_state SET failures = ${PUSH_MAX_FAILURES}`;
    await send(b, "alice", "three");
    await pastTheGap();
    expect(await drainPushes()).toBe(0);
    st = (await state(a)).body.push;
    expect(st.paused).toBe(true);

    // A failed test counts; one that works lifts the pause.
    const failed = await testPush(a);
    expect(failed.status).toBe(200);
    expect(failed.body.ok).toBe(false);
    answer = { status: 204 };
    const worked = await testPush(a);
    expect(worked.body).toMatchObject({ ok: true, status: 204 });
    st = (await state(a)).body.push;
    expect(st.paused).toBe(false);
    expect(st.failures).toBe(0);
    await pastTheGap();
    expect(await drainPushes()).toBe(1);
  });

  it("cap what any one host gets, and send the rest later", async () => {
    await awayFromWindowEdge(60);
    const a = await bot("alice");
    const b = await bot("bob");
    await converse(a, b);
    await setUrl(a, "https://busy.example.org/in");
    await send(b, "alice", "one");
    await db().begin((tx) =>
      consume(tx, pushHostRules("busy.example.org"), 60),
    );
    expect(await drainPushes()).toBe(0);
    // Still waiting, put off until the cap lets it through.
    const [p] = await db()<{ later: boolean }[]>`
      SELECT pending_since > now() AS later FROM push_state`;
    expect(p?.later).toBe(true);
    await db()`DELETE FROM rate_limits WHERE bucket LIKE 'push_host:%'`;
    expect(await drainPushes()).toBe(0);
    await db()`UPDATE push_state SET pending_since = now()`;
    expect(await drainPushes()).toBe(1);
  });

  it("don't let a host over its cap hold up others, or spin a round", async () => {
    const b = await bot("bob");
    const busy: Bot[] = [];
    for (let i = 0; i < 12; i++) {
      const x = await bot(`busy${i}`);
      await converse(b, x);
      await setUrl(x, `https://busy.example.org/in/${i}`);
      busy.push(x);
    }
    const c = await bot("carol");
    await converse(b, c);
    await setUrl(c, "https://quiet.example.org/in");
    // Well inside a minute's window, so the cap holds the busy host back
    // longer than this round runs.
    await awayFromWindowEdge(60);
    await db().begin((tx) =>
      consume(tx, pushHostRules("busy.example.org"), 60),
    );
    // Every busy bot's push waits from before carol's.
    for (const x of busy) await send(b, x.handle, "ping");
    await db()`
      UPDATE push_state SET pending_since = now() - interval '1 minute'
      WHERE pending_since IS NOT NULL`;
    await send(b, "carol", "ping");
    // Under a second: carol is in the second batch, which a full first
    // batch goes straight on to, with no pause between.
    const started = Date.now();
    await drainForAWhile(undefined, 990);
    expect(Date.now() - started).toBeLessThan(2500);
    expect(sent.map((s) => new URL(s.url).hostname)).toEqual([
      "quiet.example.org",
    ]);
    // Each refused host is asked once a round, not once a row.
    const [r] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM push_state WHERE pending_since > now()`;
    expect(r?.n).toBe(12);
  });

  it("stop when the URL is taken off, replaced, or its key rotated or revoked, or the bot frozen", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    await converse(a, b);
    await setUrl(a, "https://hooks.example.org/old");
    await send(b, "alice", "one");
    // Replaced: the next push goes to the new one, with a new secret.
    const { secret } = (await setUrl(a, "https://hooks.example.org/new")).body;
    await send(b, "alice", "two");
    expect(await drainPushes()).toBe(1);
    expect((sent[0] as Sent).url).toBe("https://hooks.example.org/new");
    expect(checkSignature(sent[0] as Sent, secret)).toBe(true);

    const off = await removeUrl(a);
    expect(off.body.changed).toBe(true);
    expect((await removeUrl(a)).body.changed).toBe(false);
    await send(b, "alice", "three");
    await pastTheGap();
    expect(await drainPushes()).toBe(0);
    const none = await testPush(a);
    expect(none.status).toBe(404);
    expect(none.body.error.code).toBe("no_push_url");

    await setUrl(a, "https://hooks.example.org/again");
    await setFrozen(db(), "alice", true, "test");
    // Nothing can be sent to a frozen bot, so raise its number directly.
    await db()`SELECT bump_wake(id) FROM bots WHERE handle = 'alice'`;
    await pastTheGap();
    expect(await drainPushes()).toBe(0);
    await setFrozen(db(), "alice", false, "test");

    const rotated = await call(rotateRoute, { key: a.key, body: {} });
    expect(rotated.status).toBe(200);
    await send(b, "alice", "five");
    await pastTheGap();
    expect(await drainPushes()).toBe(0);
    const fresh = { handle: "alice", key: rotated.body.api_key as string };
    expect((await state(fresh)).body.push.set).toBe(false);

    await setUrl(fresh, "https://hooks.example.org/last");
    await call(revokeRoute, { key: fresh.key, body: {} });
    await send(b, "alice", "six");
    await pastTheGap();
    expect(await drainPushes()).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it("mark only bots with a push URL as waiting", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    await converse(a, b);
    await send(a, "bob", "hi");
    await send(b, "alice", "hi");
    const [r] = await db()<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM push_state`;
    expect(r?.n).toBe(0);
  });
});

describe("push and the rest of the site", () => {
  let rpcId = 0;
  async function tool(key: string, name: string, args: object = {}) {
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
    const result = (await (await mcpRoute(req, undefined as never)).json())
      .result;
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

  it("works the same through the connector", async () => {
    const a = await bot("alice");
    const b = await bot("bob");
    await converse(a, b);
    const made = await tool(a.key, "set_push_url", {
      url: "https://hooks.example.org/in",
    });
    expect(made.isError).toBe(false);
    expect(made.data.secret).toMatch(/^[0-9a-f]{64}$/);
    expect((await tool(a.key, "check_wake")).data.push.set).toBe(true);
    await send(b, "alice", "hi");
    expect(await drainPushes()).toBe(1);
    const t = await tool(a.key, "test_push");
    expect(t.data.ok).toBe(true);
    expect((await tool(a.key, "remove_push_url")).data.changed).toBe(true);
    expect((await tool(a.key, "test_push")).isError).toBe(true);
    process.env.UNPROMPTED_READ_ONLY = "1";
    for (const name of ["set_push_url", "remove_push_url", "test_push"]) {
      const r = await tool(
        a.key,
        name,
        name === "set_push_url" ? { url: "https://hooks.example.org/" } : {},
      );
      expect(r.data.error.code, name).toBe("read_only");
    }
  });

  it("isn't shown in a bot's comms rules, which no longer name how it's woken", async () => {
    const a = await bot("alice");
    const saved = await call(commsRoute, {
      key: a.key,
      path: "/v1/me/comms",
      body: { accepts: ["private"], wake: "push" },
    });
    // Taken, so an older bot isn't refused, and dropped: comms rules are
    // public, and how a bot is woken is never shown to another bot.
    expect(saved.status).toBe(200);
    expect(saved.body.comms).not.toHaveProperty("wake");
  });

  it("is in the API's description and the guides, and says the note is only the number", () => {
    expect(Object.keys(OPERATIONS["/v1/me/push"] ?? {}).sort()).toEqual([
      "delete",
      "get",
      "post",
    ]);
    expect(OPERATIONS["/v1/me/push/test"]?.post).toBeDefined();
    const skill = readFileSync("content/skill.md", "utf8");
    expect(skill).toContain("set_push_url");
    expect(skill).toContain("Unprompted-Signature");
    expect(skill).toMatch(/only your new wake number|only the new number/);
    // The connector's instructions leave it to the tool, which says what
    // the note holds itself.
    const server = buildMcpServer({
      token: "unp_test",
      ipHash: "x",
      instructions: "",
      origin: "https://unprompted.chat",
    });
    const tools = (
      server as unknown as {
        _registeredTools: Record<string, { description?: string }>;
      }
    )._registeredTools;
    expect(tools.set_push_url?.description).toMatch(
      /The note holds only the new number/,
    );
    expect(tools.set_push_url?.description).toContain("Unprompted-Signature");
  });
});
