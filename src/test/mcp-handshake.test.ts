import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { POST as revokeRoute } from "@/app/v1/me/keys/revoke/route";
import { addAdmin } from "@/lib/admins";
import { builtInText, saveBotText } from "@/lib/bot-texts";
import { closeDb, db } from "@/lib/db";
import { MAX_BODY_BYTES } from "@/lib/http";
import { kickPushes } from "@/lib/push-kick";
import { BOT_TEXT_CACHE_SECONDS, botTextTag } from "@/lib/shared-cache";
import { call, freshIp, register, resetDb } from "./helpers";
import {
  cachedKeys,
  PINNED_CLOCK,
  setCacheClock,
  settleNextCache,
  updateTag,
} from "./next-cache";

// The connector's handshake (initialize, ping, tools/list and the initialized
// notice) is answered without the database: no token lookup, instructions
// from the cache, no push kick. Everything else checks the token as before.

// Every read and write starts with db(), so counting its calls counts the
// handshake's trips to the database.
vi.mock("@/lib/db", async (original) => {
  const real = await original<typeof import("@/lib/db")>();
  return { ...real, db: vi.fn(real.db) };
});
vi.mock("@/lib/push-kick", async (original) => {
  const real = await original<typeof import("@/lib/push-kick")>();
  return { ...real, kickPushes: vi.fn(real.kickPushes) };
});

beforeEach(resetDb);
afterEach(() => {
  vi.mocked(kickPushes).mockClear();
  vi.restoreAllMocks();
});

const HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  host: "unprompted.test",
};

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
};
const PING = { jsonrpc: "2.0", id: 2, method: "ping" };
const LIST = { jsonrpc: "2.0", id: 3, method: "tools/list" };
const INITIALIZED = { jsonrpc: "2.0", method: "notifications/initialized" };
const WHOAMI = {
  jsonrpc: "2.0",
  id: 4,
  method: "tools/call",
  params: { name: "whoami", arguments: {} },
};

async function send(
  token: string | undefined,
  body: unknown,
  opts: { headers?: Record<string, string>; raw?: string } = {},
) {
  const headers: Record<string, string> = {
    ...HEADERS,
    "x-real-ip": freshIp(),
    ...opts.headers,
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await mcpRoute(
    new Request("http://unprompted.test/v1/mcp", {
      method: "POST",
      headers,
      body: opts.raw ?? JSON.stringify(body),
    }),
    undefined as never,
  );
  const text = await res.text();
  // biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary JSON
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, body: json, headers: res.headers };
}

// The database calls made by `fn`.
async function trips(fn: () => Promise<unknown>): Promise<number> {
  const before = vi.mocked(db).mock.calls.length;
  await fn();
  return vi.mocked(db).mock.calls.length - before;
}

const MADE_UP = "unp_madeup_token_that_is_nobodys";

describe("the connector's handshake", () => {
  it("answers each handshake message with a token without the database", async () => {
    // A first initialize fills the instructions' cache.
    expect((await send(MADE_UP, INIT)).status).toBe(200);
    for (const msg of [INIT, PING, LIST]) {
      let res: Awaited<ReturnType<typeof send>> | undefined;
      expect(
        await trips(async () => {
          res = await send(MADE_UP, msg);
        }),
        msg.method,
      ).toBe(0);
      expect(res?.status, msg.method).toBe(200);
      expect(res?.body.id).toBe(msg.id);
      expect(res?.body.error).toBeUndefined();
    }
    expect(await trips(() => send(MADE_UP, INITIALIZED))).toBe(0);
    expect((await send(MADE_UP, INITIALIZED)).status).toBe(202);
    // Nothing was written, so nothing is pushed.
    expect(kickPushes).not.toHaveBeenCalled();
  });

  it("gives the instructions at initialize, and lists the tools", async () => {
    const init = await send(MADE_UP, INIT);
    expect(init.body.result.instructions).toContain("sign_up");
    expect(init.body.result.instructions).toContain(
      "https://unprompted.test/skill.md",
    );
    expect(init.body.result.instructions).not.toContain("{{BASE_URL}}");
    const list = await send(MADE_UP, LIST);
    const names = list.body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("whoami");
    expect(names).toContain("sign_up");
  });

  it("needs no database for ping or tools/list, even with nothing cached", async () => {
    expect(await trips(() => send(MADE_UP, PING))).toBe(0);
    expect(await trips(() => send(MADE_UP, LIST))).toBe(0);
    expect(await trips(() => send(MADE_UP, [PING, LIST]))).toBe(0);
  });

  it("answers a batch made only of handshake messages without the database", async () => {
    await send(MADE_UP, INIT);
    let res: Awaited<ReturnType<typeof send>> | undefined;
    expect(
      await trips(async () => {
        res = await send(MADE_UP, [PING, LIST, INITIALIZED]);
      }),
    ).toBe(0);
    expect(res?.status).toBe(200);
    expect(res?.body.map((r: { id: number }) => r.id).sort()).toEqual([2, 3]);
  });

  it("still answers when the database can't be reached, with the built-in instructions", async () => {
    const url = process.env.DATABASE_URL;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await closeDb();
    process.env.DATABASE_URL = "postgres://nobody:x@127.0.0.1:1/nowhere_test";
    try {
      const init = await send(MADE_UP, INIT);
      expect(init.status).toBe(200);
      expect(init.body.result.instructions).toBe(
        (await builtInText("mcp")).replaceAll(
          "{{BASE_URL}}",
          "https://unprompted.test",
        ),
      );
      expect((await send(MADE_UP, LIST)).status).toBe(200);
      expect((await send(MADE_UP, PING)).status).toBe(200);
      // A tool call needs the token checked, so it can't go on.
      const tool = await send(MADE_UP, WHOAMI);
      expect(tool.status).toBe(500);
      expect(tool.body.error.code).toBe("internal");
    } finally {
      await closeDb();
      process.env.DATABASE_URL = url;
      error.mockRestore();
    }
    // The built-in text it fell back on wasn't kept as if it were the
    // store's: an admin's version shows at once.
    await saveMcp("From the admin.");
    expect((await send(MADE_UP, INIT)).body.result.instructions).toBe(
      "From the admin.",
    );
  });

  it("still refuses every message without a token", async () => {
    for (const msg of [INIT, PING, LIST, INITIALIZED, [PING, LIST]]) {
      const res = await send(undefined, msg);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("missing_key");
      expect(res.headers.get("www-authenticate")).toContain(
        "resource_metadata=",
      );
    }
    expect(kickPushes).not.toHaveBeenCalled();
  });
});

describe("everything else on /mcp", () => {
  it("refuses a made-up token at its first tool call", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await send(MADE_UP, WHOAMI);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("invalid_key");
    expect(res.headers.get("www-authenticate")).toContain(
      'error="invalid_token"',
    );
    // Logged as a refusal, as before.
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
      status: 401,
      code: "invalid_key",
    });
  });

  it("lets a revoked token connect, and refuses its first tool call", async () => {
    const bot = await register("alice");
    expect((await send(bot.key, WHOAMI)).body.result.isError).toBeUndefined();
    expect((await call(revokeRoute, { key: bot.key })).status).toBe(200);
    expect((await send(bot.key, INIT)).status).toBe(200);
    expect((await send(bot.key, LIST)).status).toBe(200);
    expect((await send(bot.key, WHOAMI)).status).toBe(401);
  });

  it("checks the token for a batch that mixes the handshake with a tool call", async () => {
    expect(await trips(() => send(MADE_UP, [PING, WHOAMI]))).toBeGreaterThan(0);
    const res = await send(MADE_UP, [PING, LIST, WHOAMI]);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("invalid_key");
    // A live token gets every answer.
    const bot = await register("bob");
    const ok = await send(bot.key, [PING, WHOAMI]);
    expect(ok.status).toBe(200);
    expect(ok.body.map((r: { id: number }) => r.id).sort()).toEqual([2, 4]);
  });

  it("checks the token for anything odd, so it's answered as before", async () => {
    const odd: { name: string; body?: unknown; raw?: string; h?: object }[] = [
      { name: "not JSON", raw: "{nope" },
      { name: "empty batch", body: [] },
      { name: "initialize in a batch", body: [INIT, PING] },
      { name: "no jsonrpc", body: { id: 1, method: "ping" } },
      { name: "ping as a notice", body: { jsonrpc: "2.0", method: "ping" } },
      {
        name: "initialized with an id",
        body: { ...INITIALIZED, id: 9 },
      },
      { name: "bad initialize", body: { ...INIT, params: {} } },
      { name: "another method", body: { ...PING, method: "resources/list" } },
      { name: "too big", raw: JSON.stringify(paddedPing(MAX_BODY_BYTES + 1)) },
      { name: "two tool lists", body: [LIST, { ...LIST, id: 8 }] },
      {
        name: "accepts only JSON",
        body: PING,
        h: { accept: "application/json" },
      },
      {
        name: "not sent as JSON",
        body: PING,
        h: { "content-type": "text/plain" },
      },
      {
        name: "unknown protocol version",
        body: PING,
        h: { "mcp-protocol-version": "1999-01-01" },
      },
    ];
    for (const o of odd) {
      const res = await send(MADE_UP, o.body, {
        raw: o.raw,
        headers: o.h as Record<string, string> | undefined,
      });
      expect(res.status, o.name).toBe(401);
      expect(res.body.error.code, o.name).toBe("invalid_key");
    }
    // With a live token the transport answers them, as before.
    const bot = await register("carol");
    expect((await send(bot.key, undefined, { raw: "{nope" })).status).toBe(400);
    const big = await send(bot.key, undefined, {
      raw: JSON.stringify(paddedPing(MAX_BODY_BYTES + 1)),
    });
    expect(big.status).toBe(413);
    expect((await send(bot.key, [INIT, PING])).status).toBe(400);
    const lists = await send(bot.key, [LIST, { ...LIST, id: 8 }]);
    expect(lists.status).toBe(200);
    expect(lists.body).toHaveLength(2);
  });

  it("reads at most MAX_BODY_BYTES of a body before checking the token", async () => {
    // The same ping, padded inside its params: within the limit it's the
    // handshake; over it, it takes the full path and the token is checked.
    const small = await send(MADE_UP, undefined, {
      raw: JSON.stringify(paddedPing(MAX_BODY_BYTES - 200)),
    });
    expect(small.status).toBe(200);
    expect(small.body.result).toEqual({});
    const over = await send(MADE_UP, undefined, {
      raw: JSON.stringify(paddedPing(MAX_BODY_BYTES + 1)),
    });
    expect(over.status).toBe(401);
    expect(over.body.error.code).toBe("invalid_key");
  });

  it("lists the tools at most once per batch without a checked token", async () => {
    // The list is large: two in one batch from a small request would
    // multiply what an unchecked caller can pull.
    const one = await send(MADE_UP, [LIST, PING]);
    expect(one.status).toBe(200);
    const raw = JSON.stringify([LIST, { ...LIST, id: 8 }, { ...LIST, id: 9 }]);
    expect(raw.length).toBeLessThan(200);
    const many = await send(MADE_UP, undefined, { raw });
    expect(many.status).toBe(401);
    expect(many.body.error.code).toBe("invalid_key");
  });

  it("takes a batch of up to eight handshake messages without a checked token", async () => {
    const pings = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ ...PING, id: 100 + i }));
    const eight = await send(MADE_UP, pings(8));
    expect(eight.status).toBe(200);
    expect(eight.body).toHaveLength(8);
    const nine = await send(MADE_UP, pings(9));
    expect(nine.status).toBe(401);
    expect(nine.body.error.code).toBe("invalid_key");
  });

  it("pushes after a tool call, as before", async () => {
    const bot = await register("dave");
    vi.mocked(kickPushes).mockClear();
    await send(bot.key, WHOAMI);
    expect(kickPushes).toHaveBeenCalledTimes(1);
  });
});

// A ping whose JSON is `bytes` long, padded inside its params.
function paddedPing(bytes: number) {
  const base = JSON.stringify({ ...PING, params: { pad: "" } }).length;
  return { ...PING, params: { pad: "x".repeat(bytes - base) } };
}

async function saveMcp(body: string | null) {
  const [row] = await db()<{ id: string }[]>`
    SELECT id FROM bot_text_versions WHERE key = 'mcp' ORDER BY id DESC LIMIT 1`;
  const [human] = await db()<{ id: string }[]>`SELECT id FROM humans LIMIT 1`;
  const humanId = human
    ? Number(human.id)
    : (await addAdmin(db(), { authUserId: "google-admin" }, "Admin.", "x"))
        .humanId;
  return saveBotText(db(), {
    key: "mcp",
    body,
    after: row ? Number(row.id) : 0,
    humanId,
    ipHash: null,
  });
}

describe("the connector's instructions in the cache", () => {
  it("keeps them until an admin's save clears them", async () => {
    const builtIn = (await builtInText("mcp")).replaceAll(
      "{{BASE_URL}}",
      "https://unprompted.test",
    );
    expect((await send(MADE_UP, INIT)).body.result.instructions).toBe(builtIn);
    // A save that doesn't go through the admin page leaves the cache as it
    // was...
    await saveMcp("Newer words for apps.");
    expect((await send(MADE_UP, INIT)).body.result.instructions).toBe(builtIn);
    // ...and the admin page's save clears it (src/test/admin-web.test.ts
    // checks that the page does).
    updateTag(botTextTag("mcp"));
    expect((await send(MADE_UP, INIT)).body.result.instructions).toBe(
      "Newer words for apps.",
    );
  });

  it("reads them again when the hour's bucket turns over, on the first read after it", async () => {
    const size = BOT_TEXT_CACHE_SECONDS * 1000;
    const start = (Math.floor(PINNED_CLOCK / size) + 1) * size;
    setCacheClock(start + 1000);
    await send(MADE_UP, INIT);
    await saveMcp("Words for later.");
    // Late in the same bucket, still the cached text, and nothing refreshes
    // it in the background...
    setCacheClock(start + size - 1000);
    expect((await send(MADE_UP, INIT)).body.result.instructions).not.toBe(
      "Words for later.",
    );
    await settleNextCache();
    expect((await send(MADE_UP, INIT)).body.result.instructions).not.toBe(
      "Words for later.",
    );
    // ...and the first read in the next one is fresh.
    setCacheClock(start + size + 1);
    expect((await send(MADE_UP, INIT)).body.result.instructions).toBe(
      "Words for later.",
    );
  });

  it("never serves what was cached before a deploy changed the built-in file", async () => {
    await saveMcp("The admin's words, over today's file.");
    expect((await send(MADE_UP, INIT)).body.result.instructions).toBe(
      "The admin's words, over today's file.",
    );
    const key = cachedKeys().find((k) => k.includes("bot-text"));
    expect(key).toContain(
      (await import("@/lib/bot-texts")).textHash(await builtInText("mcp")),
    );
    // A deploy brings a new content/mcp.md: the store says the admin's words
    // were saved over the old file, so the new file's words count, and the
    // cache, keyed by the file's hash, doesn't hand back the admin's.
    const dir = mkdtempSync(path.join(tmpdir(), "unprompted-content-"));
    try {
      cpSync(path.join(process.cwd(), "content"), path.join(dir, "content"), {
        recursive: true,
      });
      const file = path.join(dir, "content", "mcp.md");
      writeFileSync(
        file,
        `${readFileSync(file, "utf8")}\nA line from a deploy.\n`,
      );
      vi.spyOn(process, "cwd").mockReturnValue(dir);
      const res = await send(MADE_UP, INIT);
      expect(res.body.result.instructions).toContain("A line from a deploy.");
      expect(res.body.result.instructions).not.toContain("The admin's words");
    } finally {
      vi.restoreAllMocks();
      rmSync(dir, { recursive: true, force: true });
    }
    expect((await send(MADE_UP, INIT)).body.result.instructions).toBe(
      "The admin's words, over today's file.",
    );
  });
});
