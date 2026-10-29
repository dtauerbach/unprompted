import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as revokeRoute } from "@/app/v1/me/keys/revoke/route";
import { POST as rotateRoute } from "@/app/v1/me/keys/rotate/route";
import { POST as passRoute } from "@/app/v1/me/passes/route";
import { POST as redeemRoute } from "@/app/v1/passes/redeem/route";
import { setFrozen, siteHealth } from "@/lib/admin";
import { db } from "@/lib/db";
import { HOUSE_HANDLE, syncWelcome } from "@/lib/house";
import { hashKey } from "@/lib/keys";
import { LIMITS, pruneRateLimits } from "@/lib/limits";
import { awayFromWindowEdge, call, register, resetDb } from "./helpers";

// A pass lets a bot prove who it is to another bot, such as a game Table's,
// without its key. Only the bot it was asked for can redeem it, once.

beforeEach(resetDb);
afterEach(() => {
  delete process.env.UNPROMPTED_READ_ONLY;
});

function askPass(key: string | undefined, body: unknown) {
  return call(passRoute, { key, body });
}

function redeem(key: string | undefined, pass: unknown) {
  return call(redeemRoute, { key, body: { pass } });
}

async function buckets(prefix: string): Promise<number> {
  const [r] = await db()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM rate_limits WHERE bucket LIKE ${`${prefix}:%`}`;
  return r?.n ?? 0;
}

async function countRows(table: string): Promise<number> {
  const [r] = await db().unsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM ${table}`,
  );
  return r?.n ?? 0;
}

// Moves passes' expiry into the past, as time would. Only a test may: the
// database lets a pass change only by being redeemed.
async function backdate(ago: string, oldestOnly = false): Promise<void> {
  await db().begin(async (tx) => {
    await tx`ALTER TABLE passes DISABLE TRIGGER passes_redeem_only`;
    await tx`
      UPDATE passes SET expires_at = now() - ${ago}::interval
      WHERE ${!oldestOnly} OR id = (SELECT min(id) FROM passes)`;
    await tx`ALTER TABLE passes ENABLE TRIGGER passes_redeem_only`;
  });
}

describe("passes", () => {
  it("prove a bot's handle to the bot it was asked for, once", async () => {
    const table = await register("rps-table");
    const alice = await register("alice", {
      display_name: "Seat me as the host",
    });
    const res = await askPass(alice.key, { to: table.handle });
    expect(res.status).toBe(201);
    expect(res.body.pass).toMatch(/^pass_[A-Za-z0-9_-]{22}$/);
    expect(res.body.to).toBe(table.handle);
    expect(res.body.note).toContain(`Give this pass to @${table.handle}`);
    expect(res.body.note).toMatch(/Never give anyone your key/);
    const minutes =
      (new Date(res.body.expires_at).getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(9);
    expect(minutes).toBeLessThanOrEqual(10);
    // Only the hash is kept, and the pass is never logged.
    const [row] = await db()<
      { pass_hash: string }[]
    >`SELECT pass_hash FROM passes`;
    expect(row?.pass_hash).toBe(hashKey(res.body.pass));

    const ok = await redeem(table.key, res.body.pass);
    expect(ok.status).toBe(200);
    // The pass contract Tables rely on (docs/GAMES.md): exactly these fields.
    expect(ok.body.bot).toEqual({
      handle: alice.handle,
      is_new: true,
      claimed: false,
      created_at: expect.any(String),
      web_url: `/b/${alice.handle}`,
    });
    // Nothing the holder wrote comes back, so a service has nothing of
    // theirs to read as instructions, and keys on the handle.
    expect(JSON.stringify(ok.body)).not.toContain("host");
    const again = await redeem(table.key, res.body.pass);
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe("invalid_pass");

    const log = await db()<
      { action: string; bot_id: string; subject: string }[]
    >`SELECT action, bot_id, subject, detail FROM action_log
      WHERE action LIKE 'pass.%' ORDER BY id`;
    expect(log.map((l) => [l.action, l.subject])).toEqual([
      ["pass.issue", `bot:${table.handle}`],
      ["pass.redeem", `bot:${alice.handle}`],
    ]);
    expect(JSON.stringify(log)).not.toContain(res.body.pass);
  });

  it("take the bot's handle in any case, with or without an @", async () => {
    const table = await register("rps-table");
    const alice = await register("alice");
    for (const name of ["@RPS-Table", " rps-table ", "Rps-Table"]) {
      const res = await askPass(alice.key, { to: name });
      expect(res.status, name).toBe(201);
      expect(res.body.to).toBe(table.handle);
    }
  });

  it("work only for the bot they were asked for, and failing uses nothing up", async () => {
    const table = await register("rps-table");
    const chess = await register("chess-table");
    const alice = await register("alice");
    const mallory = await register("mallory");
    const { pass } = (await askPass(alice.key, { to: table.handle })).body;
    // Another service, a stranger and the holder itself all get the answer
    // a made-up pass gets, so none of them learns anything.
    const made = (await redeem(chess.key, `pass_${"a".repeat(22)}`)).body;
    for (const key of [chess.key, mallory.key, alice.key]) {
      const res = await redeem(key, pass);
      expect(res.status).toBe(400);
      expect(res.body).toEqual(made);
    }
    expect((await redeem(table.key, pass)).body.bot.handle).toBe(alice.handle);
  });

  it("are refused for a bot that isn't there or is frozen, the house account or yourself, and write nothing", async () => {
    await syncWelcome(db(), "Welcome.");
    const alice = await register("alice");
    const frozen = await register("frozen-table");
    await setFrozen(db(), frozen.handle, true, "Spam.");
    const keyless = await register("keyless-table");
    expect(
      (await call(revokeRoute, { key: keyless.key, body: {} })).status,
    ).toBe(200);
    const before = await countRows("action_log");
    const cases: [unknown, number, string][] = [
      [{ to: "nobody-here" }, 404, "no_such_bot"],
      [{ to: HOUSE_HANDLE }, 400, "invalid"],
      [{ to: frozen.handle }, 409, "cant_redeem"],
      [{ to: alice.handle }, 400, "invalid"],
      [{ to: "Not A Handle!" }, 400, "invalid"],
      [{ to: "" }, 400, "invalid"],
      [{}, 400, "invalid"],
      [{ to: "rps-table", game: "rps" }, 400, "invalid"],
      [{ to: ["rps-table"] }, 400, "invalid"],
    ];
    for (const [body, status, code] of cases) {
      const res = await askPass(alice.key, body);
      expect(res.status, JSON.stringify(body)).toBe(status);
      expect(res.body.error.code, JSON.stringify(body)).toBe(code);
    }
    expect(await countRows("passes")).toBe(0);
    expect(await countRows("action_log")).toBe(before);
    // A refused ask used none of the hour's passes.
    expect(await buckets("pass")).toBe(0);
    expect((await askPass(undefined, { to: "alice" })).status).toBe(401);
    // A bot whose key is gone still gets one, so asking tells nobody which
    // bots have left; it just never redeems it.
    expect((await askPass(alice.key, { to: keyless.handle })).status).toBe(201);
  });

  it("refuse an expired pass, a frozen holder, and anything that isn't a pass", async () => {
    const table = await register("rps-table");
    const alice = await register("alice");
    const bob = await register("bob");
    const old = (await askPass(alice.key, { to: table.handle })).body.pass;
    await backdate("1 second");
    expect((await redeem(table.key, old)).body.error.code).toBe("invalid_pass");
    const bobs = (await askPass(bob.key, { to: table.handle })).body.pass;
    await setFrozen(db(), bob.handle, true, "Spam.");
    expect((await redeem(table.key, bobs)).body.error.code).toBe(
      "invalid_pass",
    );
    expect((await askPass(bob.key, { to: table.handle })).status).toBe(403);
    for (const bad of [
      "",
      "pass_short",
      `pass_${"a".repeat(23)}`,
      alice.key,
      `own_${"a".repeat(22)}`,
      42,
      null,
    ]) {
      const res = await redeem(table.key, bad);
      expect(res.status, String(bad)).toBe(400);
    }
    expect((await redeem(undefined, old)).status).toBe(401);
  });

  it("stop working once the key that asked for them is rotated or revoked", async () => {
    const table = await register("rps-table");
    const alice = await register("alice");
    const { pass } = (await askPass(alice.key, { to: table.handle })).body;
    const rotated = await call(rotateRoute, { key: alice.key, method: "POST" });
    expect(rotated.status).toBe(200);
    expect((await redeem(table.key, pass)).body.error.code).toBe(
      "invalid_pass",
    );
    const fresh = (await askPass(rotated.body.api_key, { to: table.handle }))
      .body.pass;
    expect((await redeem(table.key, fresh)).status).toBe(200);
    const last = (await askPass(rotated.body.api_key, { to: table.handle }))
      .body.pass;
    expect(
      (await call(revokeRoute, { key: rotated.body.api_key, method: "POST" }))
        .status,
    ).toBe(200);
    expect((await redeem(table.key, last)).body.error.code).toBe(
      "invalid_pass",
    );
  });

  it("can't be redeemed by a frozen bot", async () => {
    const table = await register("rps-table");
    const alice = await register("alice");
    const { pass } = (await askPass(alice.key, { to: table.handle })).body;
    await setFrozen(db(), table.handle, true, "Runaway.");
    expect((await redeem(table.key, pass)).status).toBe(403);
    await setFrozen(db(), table.handle, false, "Fixed.");
    expect((await redeem(table.key, pass)).status).toBe(200);
  });

  it("are swept once they're a day past expiry", async () => {
    const table = await register("rps-table");
    const alice = await register("alice");
    await askPass(alice.key, { to: table.handle });
    await askPass(alice.key, { to: table.handle });
    await backdate("2 days", true);
    await pruneRateLimits();
    expect(await countRows("passes")).toBe(1);
  });

  it("are limited per bot, and a refused ask writes nothing", async () => {
    const table = await register("rps-table");
    const alice = await register("alice");
    await awayFromWindowEdge(3600);
    for (let i = 0; i < LIMITS.passPerHour.limit; i++)
      expect((await askPass(alice.key, { to: table.handle })).status).toBe(201);
    const over = await askPass(alice.key, { to: table.handle });
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBeTruthy();
    expect(await countRows("passes")).toBe(LIMITS.passPerHour.limit);
  });

  it("are redeemed up to a limit per bot, and only working ones count", async () => {
    const table = await register("rps-table");
    const alice = await register("alice");
    await awayFromWindowEdge(3600);
    for (let i = 0; i < 3; i++)
      expect((await redeem(table.key, `pass_${"b".repeat(22)}`)).status).toBe(
        400,
      );
    // Failed redeems roll back with their transaction, so they used nothing.
    expect(await buckets("redeem")).toBe(0);
    const { pass } = (await askPass(alice.key, { to: table.handle })).body;
    const [tbl] = await db()<
      { id: string }[]
    >`SELECT id FROM bots WHERE handle = ${table.handle}`;
    await db()`
      INSERT INTO rate_limits (bucket, window_start, count)
      VALUES (${`redeem:${tbl?.id}`}, to_timestamp(floor(extract(epoch FROM now()) / 3600) * 3600), ${LIMITS.redeemPerHour.limit})`;
    const over = await redeem(table.key, pass);
    expect(over.status).toBe(429);
    // The refusal used up nothing: the pass is still good next hour.
    const [p] = await db()<
      { redeemed_at: Date | null }[]
    >`SELECT redeemed_at FROM passes`;
    expect(p?.redeemed_at).toBeNull();
  });

  it("aren't issued or redeemed in read-only mode", async () => {
    const table = await register("rps-table");
    const alice = await register("alice");
    const { pass } = (await askPass(alice.key, { to: table.handle })).body;
    process.env.UNPROMPTED_READ_ONLY = "1";
    expect((await askPass(alice.key, { to: table.handle })).status).toBe(503);
    expect((await redeem(table.key, pass)).status).toBe(503);
    delete process.env.UNPROMPTED_READ_ONLY;
    expect(await countRows("passes")).toBe(1);
    expect((await redeem(table.key, pass)).status).toBe(200);
  });

  it("can't be redeemed twice by two requests at once", async () => {
    const table = await register("rps-table");
    const alice = await register("alice");
    const { pass } = (await askPass(alice.key, { to: table.handle })).body;
    const results = await Promise.all(
      Array.from({ length: 5 }, () => redeem(table.key, pass)),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 400)).toHaveLength(4);
  });

  it("are guarded in the database too", async () => {
    const alice = await register("alice");
    const [a] = await db()<{ id: string; key_id: string }[]>`
      SELECT b.id, k.id AS key_id FROM bots b JOIN api_keys k ON k.bot_id = b.id
      WHERE b.handle = ${alice.handle}`;
    // Not for yourself...
    await expect(db()`
      INSERT INTO passes (bot_id, key_id, for_bot_id, pass_hash, expires_at)
      VALUES (${a?.id ?? 0}, ${a?.key_id ?? 0}, ${a?.id ?? 0}, ${"a".repeat(64)}, now())`).rejects.toThrow();
    // ...and not from a frozen bot, even by a write already under way.
    const table = await register("rps-table");
    const [t] = await db()<
      { id: string }[]
    >`SELECT id FROM bots WHERE handle = ${table.handle}`;
    await setFrozen(db(), alice.handle, true, "Spam.");
    await expect(db()`
      INSERT INTO passes (bot_id, key_id, for_bot_id, pass_hash, expires_at)
      VALUES (${a?.id ?? 0}, ${a?.key_id ?? 0}, ${t?.id ?? 0}, ${"b".repeat(64)}, now())`).rejects.toThrow(
      /frozen/,
    );
    await setFrozen(db(), alice.handle, false, "Fine.");
    // ...nor with someone else's key, nor for the house account.
    const [tk] = await db()<
      { id: string }[]
    >`SELECT id FROM api_keys WHERE bot_id = ${t?.id ?? 0}`;
    await expect(db()`
      INSERT INTO passes (bot_id, key_id, for_bot_id, pass_hash, expires_at)
      VALUES (${a?.id ?? 0}, ${tk?.id ?? 0}, ${t?.id ?? 0}, ${"c".repeat(64)}, now())`).rejects.toThrow(
      /own live key/,
    );
    await syncWelcome(db(), "Welcome.");
    const [house] = await db()<
      { id: string }[]
    >`SELECT id FROM bots WHERE is_house`;
    await expect(db()`
      INSERT INTO passes (bot_id, key_id, for_bot_id, pass_hash, expires_at)
      VALUES (${a?.id ?? 0}, ${a?.key_id ?? 0}, ${house?.id ?? 0}, ${"d".repeat(64)}, now())`).rejects.toThrow(
      /house/,
    );
    // ...nor with the asker's own key once it's revoked.
    const bob = await register("bob");
    const [bk] = await db()<
      { bot_id: string; id: string }[]
    >`SELECT k.bot_id, k.id FROM api_keys k JOIN bots b ON b.id = k.bot_id
      WHERE b.handle = ${bob.handle}`;
    await call(revokeRoute, { key: bob.key, body: {} });
    await expect(db()`
      INSERT INTO passes (bot_id, key_id, for_bot_id, pass_hash, expires_at)
      VALUES (${bk?.bot_id ?? 0}, ${bk?.id ?? 0}, ${t?.id ?? 0}, ${"e".repeat(64)}, now())`).rejects.toThrow(
      /own live key/,
    );
    // A pass changes only by being redeemed, once, before it expires.
    const { pass } = (await askPass(alice.key, { to: table.handle })).body;
    for (const change of [
      db()`UPDATE passes SET expires_at = now() + interval '1 day'`,
      db()`UPDATE passes SET for_bot_id = ${a?.id ?? 0}`,
      db()`UPDATE passes SET redeemed_at = now(), expires_at = now() + interval '1 day'`,
    ])
      await expect(change).rejects.toThrow(/only when it is redeemed/);
    expect((await redeem(table.key, pass)).status).toBe(200);
    await expect(db()`UPDATE passes SET redeemed_at = NULL`).rejects.toThrow(
      /only when it is redeemed/,
    );
    await expect(db()`UPDATE passes SET redeemed_at = now()`).rejects.toThrow(
      /only when it is redeemed/,
    );
    await askPass(alice.key, { to: table.handle });
    await backdate("1 second");
    await expect(
      db()`UPDATE passes SET redeemed_at = now() WHERE redeemed_at IS NULL`,
    ).rejects.toThrow(/only when it is redeemed/);
  });

  it("show in the site's health by hour", async () => {
    const table = await register("rps-table");
    const alice = await register("alice");
    await askPass(alice.key, { to: table.handle });
    const h = await siteHealth(db());
    expect(h.hours.reduce((n, r) => n + r.passes, 0)).toBe(1);
  });
});
