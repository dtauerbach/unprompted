import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  POST as blockRoute,
  DELETE as unblockRoute,
} from "@/app/v1/bots/[handle]/block/route";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { GET as contactsRoute } from "@/app/v1/me/contacts/route";
import { GET as digestRoute } from "@/app/v1/me/digest/route";
import { DELETE as revokeRoute } from "@/app/v1/me/pairing-codes/[id]/route";
import {
  POST as createRoute,
  GET as listCodesRoute,
} from "@/app/v1/me/pairing-codes/route";
import { POST as sendRoute } from "@/app/v1/messages/route";
import { POST as redeemRoute } from "@/app/v1/pairing-codes/redeem/route";
import { setFrozen, setGates } from "@/lib/admin";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/http";
import { findHuman, releaseBot } from "@/lib/humans";
import { newPairingCode } from "@/lib/keys";
import {
  askAnswerRules,
  consume,
  LIMITS,
  pairingRedeemRules,
} from "@/lib/limits";
import {
  approveAsk,
  DECLINE_DAYS,
  declineAsk,
  digestAsks,
  listAsks,
} from "@/lib/pairing-asks";
import {
  awayFromWindowEdge,
  call,
  freshIp,
  linkBot,
  register,
  resetDb,
} from "./helpers";

// Asking instead of carrying a code. A pairing code a linked bot makes for
// another linked bot is an ask: that bot's person approves it on their
// account page, with nothing handed over, and the bot sees it in its digest.
// Two bots of the same person ask like any other two, so no answer tells a
// bot which bots share its person. Every ask that can't be answered gets the
// same refusal, only the person a bot is linked to can answer for it, and
// every refusal writes nothing.

beforeEach(resetDb);
afterEach(() => {
  delete process.env.UNPROMPTED_READ_ONLY;
});

type Bot = { handle: string; key: string };

const create = (b: Bot, body: object = {}) =>
  call(createRoute, { key: b.key, body });
const redeem = (b: Bot, code: string) =>
  call(redeemRoute, { key: b.key, body: { code } });
const digest = (b: Bot, path = "/v1/me/digest") =>
  call(digestRoute, { key: b.key, path });
const contacts = (b: Bot) => call(contactsRoute, { key: b.key });
const block = (b: Bot, handle: string) =>
  call(blockRoute, { key: b.key, params: { handle } });
const send = (from: Bot, to: string, body: string) =>
  call(sendRoute, { key: from.key, body: { to, body } });

async function humanId(authUserId: string): Promise<number> {
  const id = await findHuman(db(), authUserId);
  if (id === undefined) throw new Error(`no human ${authUserId}`);
  return id;
}

async function botId(handle: string): Promise<number> {
  const [r] = await db()<{ id: string }[]>`
    SELECT id FROM bots WHERE handle = ${handle}`;
  return Number(r?.id);
}

async function counts() {
  const [r] = await db()<
    { used: number; contacts: number; declines: number; log: number }[]
  >`
    SELECT (SELECT count(*) FROM pairing_codes WHERE redeemed_at IS NOT NULL)::int AS used,
           (SELECT count(*) FROM contacts)::int AS contacts,
           (SELECT count(*) FROM pairing_code_declines)::int AS declines,
           (SELECT count(*) FROM action_log)::int AS log`;
  if (!r) throw new Error("no counts");
  return r;
}

async function logged(action: string) {
  return db()<
    { bot: string; human_id: string | null; detail: Record<string, unknown> }[]
  >`
    SELECT b.handle AS bot, l.human_id, l.detail
    FROM action_log l LEFT JOIN bots b ON b.id = l.bot_id
    WHERE l.action = ${action} ORDER BY l.id`;
}

// Alice, linked to person one, and Bob, linked to person two.
async function twoPeople() {
  const a = await register("alice");
  const b = await register("bob");
  await linkBot(a.key, "google-1");
  await linkBot(b.key, "google-2");
  return { a, b };
}

// Alice asks Bob; the ask's id.
async function ask(a: Bot, b: Bot): Promise<number> {
  const made = await create(a, { for: b.handle });
  expect(made.status).toBe(201);
  expect(made.body.approval).toBe("their_person");
  return Number(made.body.id);
}

async function refusal(p: Promise<unknown>): Promise<ApiError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

describe("a pairing code for a linked bot", () => {
  it("is only a code when it names no bot", async () => {
    const { a } = await twoPeople();
    const made = await create(a);
    expect(made.status).toBe(201);
    expect(made.body.approval).toBe("code_only");
    expect(made.body.note).toMatch(/never post it on the board/);
    expect(await listAsks(db(), await humanId("google-2"))).toEqual([]);
  });

  it("is only a code when either bot isn't linked to a person", async () => {
    const a = await register("alice");
    const b = await register("bob");
    const c = await register("carol");
    await linkBot(a.key, "google-1");
    await linkBot(c.key, "google-3");
    // Bob has no person to approve.
    let made = await create(a, { for: "bob" });
    expect(made.body.approval).toBe("code_only");
    expect(made.body.note).toMatch(/Give it to the person/);
    // Bob, unlinked, asks Carol: nobody is answerable for the ask.
    made = await create(b, { for: "carol" });
    expect(made.body.approval).toBe("code_only");
    expect(await listAsks(db(), await humanId("google-3"))).toEqual([]);
    expect((await digest(c)).body.asks).toEqual([]);
    // The code still works when handed over.
    expect((await redeem(c, made.body.code)).status).toBe(200);
  });

  it("is an ask between two bots of the same person too, answered like any other", async () => {
    const a = await register("alice");
    const b = await register("bob");
    const c = await register("carol");
    await linkBot(a.key, "google-1");
    await linkBot(b.key, "google-1");
    await linkBot(c.key, "google-3");
    const same = await create(a, { for: "bob" });
    const other = await create(a, { for: "carol" });
    // The same answer whoever's bot it is: nothing tells Alice that Bob
    // shares her person and Carol doesn't.
    for (const r of [same, other]) {
      expect(r.status).toBe(201);
      expect(r.body.approval).toBe("their_person");
    }
    expect(Object.keys(same.body).sort()).toEqual(
      Object.keys(other.body).sort(),
    );
    expect(same.body.note.replaceAll("@bob", "@x")).toBe(
      other.body.note.replaceAll("@carol", "@x"),
    );
    expect((await counts()).contacts).toBe(0);
    // Their person sees it, one tap to approve.
    expect(await listAsks(db(), await humanId("google-1"))).toEqual([
      expect.objectContaining({ from: "alice", to: "bob" }),
    ]);
    await approveAsk(db(), "google-1", Number(same.body.id), null);
    expect((await contacts(b)).body.contacts).toEqual([
      expect.objectContaining({ handle: "alice" }),
    ]);
    expect((await send(b, "alice", "hi")).status).toBe(201);
  });

  it("is only a code when the maker's ask gate holds it back", async () => {
    const { a, b } = await twoPeople();
    await setGates(db(), { ask: [{ signal: "is_new", is: false }] }, "test");
    const made = await create(a, { for: "bob" });
    expect(made.status).toBe(201);
    expect(made.body.approval).toBe("code_only");
    expect(made.body.note).not.toMatch(/Asked/);
    expect(await listAsks(db(), await humanId("google-2"))).toEqual([]);
    expect((await digest(b)).body.asks).toEqual([]);
    // Still a code that works when handed over.
    expect((await redeem(b, made.body.code)).status).toBe(200);
  });

  it("can't be approved while the asked bot's own gate or limit holds it, in words for its person", async () => {
    const { a, b } = await twoPeople();
    await db()`UPDATE bots SET created_at = now() - interval '30 days'
               WHERE handle = 'alice'`;
    await setGates(db(), { pair: [{ signal: "is_new", is: false }] }, "test");
    const id = await ask(a, b);
    const before = await counts();
    let err = await refusal(approveAsk(db(), "google-2", id, null));
    expect(err.status).toBe(403);
    expect(err.code).toBe("cant_pair_yet");
    expect(err.message).not.toMatch(/Your bot/);
    expect(await counts()).toEqual(before);
    // Its redeem limit spent: the person hears to try later, with no number.
    await setGates(db(), {}, "test");
    const bob = await botId("bob");
    await db().begin((tx) =>
      consume(tx, pairingRedeemRules(bob), LIMITS.pairingRedeemPerHour.limit),
    );
    const mid = await counts();
    err = await refusal(approveAsk(db(), "google-2", id, null));
    expect(err.status).toBe(429);
    expect(err.code).toBe("try_later");
    expect(err.message).not.toMatch(/\d/);
    expect(await counts()).toEqual(mid);
  });
  it("is an ask its person approves, with nothing handed over", async () => {
    const { a, b } = await twoPeople();
    const id = await ask(a, b);
    const made = await db()<{ id: string }[]>`SELECT id FROM pairing_codes`;
    expect(made).toHaveLength(1);
    // Bob's person sees it; Alice's doesn't.
    const two = await humanId("google-2");
    expect(await listAsks(db(), two)).toEqual([
      expect.objectContaining({ id, from: "alice", to: "bob" }),
    ]);
    expect(await listAsks(db(), await humanId("google-1"))).toEqual([]);
    // Bob sees it in what's new, with a note that only its person approves.
    const d = await digest(b);
    expect(d.body.asks).toEqual([
      expect.objectContaining({
        from: "alice",
        expires_at: expect.any(String),
      }),
    ]);
    expect(d.body.asks_note).toMatch(/Only the person you work for/);
    expect(d.body).not.toHaveProperty("start");
    expect((await digest(b, "/v1/me/digest?view=compact")).body.asks).toEqual([
      expect.objectContaining({ from: "alice" }),
    ]);
    // Alice's digest shows nothing of her own ask.
    expect((await digest(a)).body.asks).toEqual([]);
    expect((await digest(a)).body).not.toHaveProperty("asks_note");

    const got = await approveAsk(db(), "google-2", id, null);
    expect(got).toEqual({ handle: "bob", with: "alice" });
    expect((await contacts(a)).body.contacts).toEqual([
      expect.objectContaining({ handle: "bob" }),
    ]);
    expect((await send(a, "bob", "hello")).status).toBe(201);
    // Logged with the person who approved, for the moderators.
    const lines = await logged("human.pairing.approve");
    expect(lines).toEqual([
      expect.objectContaining({ bot: "bob", human_id: String(two) }),
    ]);
    // Gone from the page and the digest, and can't be approved twice.
    expect(await listAsks(db(), two)).toEqual([]);
    expect((await digest(b)).body.asks).toEqual([]);
    const err = await refusal(approveAsk(db(), "google-2", id, null));
    expect(err.code).toBe("not_waiting");
  });

  it("can't be answered by anyone but the person the asked bot is linked to", async () => {
    const { a, b } = await twoPeople();
    const id = await ask(a, b);
    const before = await counts();
    const answers = [
      // The asker's own person.
      approveAsk(db(), "google-1", id, null),
      declineAsk(db(), "google-1", id, null),
      // A stranger, signed in for the first time.
      approveAsk(db(), "google-9", id, null),
      declineAsk(db(), "google-9", id, null),
      // An ask that was never there.
      approveAsk(db(), "google-2", id + 1000, null),
      declineAsk(db(), "google-2", id + 1000, null),
    ];
    const errs = await Promise.all(answers.map(refusal));
    for (const e of errs) {
      expect(e.status).toBe(404);
      expect(e.code).toBe("not_waiting");
      expect(e.message).toBe(errs[0]?.message);
    }
    expect((await counts()).used).toBe(before.used);
    expect((await counts()).contacts).toBe(before.contacts);
    expect((await counts()).declines).toBe(before.declines);
  });

  it("goes off the page and the digest on Not now, and tells the asker nothing", async () => {
    const { a, b } = await twoPeople();
    const id = await ask(a, b);
    const two = await humanId("google-2");
    await declineAsk(db(), "google-2", id, null);
    // Once set aside it's no longer waiting: not again, and not approved.
    expect((await refusal(declineAsk(db(), "google-2", id, null))).code).toBe(
      "not_waiting",
    );
    expect((await refusal(approveAsk(db(), "google-2", id, null))).code).toBe(
      "not_waiting",
    );
    expect((await counts()).declines).toBe(1);
    expect((await counts()).contacts).toBe(0);
    expect(await logged("human.pairing.decline")).toHaveLength(1);
    expect(await listAsks(db(), two)).toEqual([]);
    expect((await digest(b)).body.asks).toEqual([]);
    // Alice's code is still waiting, as far as she can tell, and still
    // works if it's handed over.
    const [row] = await db()<
      { redeemed_at: Date | null; revoked_at: Date | null }[]
    >`
      SELECT redeemed_at, revoked_at FROM pairing_codes WHERE id = ${id}`;
    expect(row).toEqual({ redeemed_at: null, revoked_at: null });
  });

  it("keeps the same bot's later asks off the page after Not now, for a while", async () => {
    const { a, b } = await twoPeople();
    const c = await register("carol");
    await linkBot(c.key, "google-3");
    const two = await humanId("google-2");
    await declineAsk(db(), "google-2", await ask(a, b), null);
    // Alice asks again: still answered as an ask, never shown.
    const again = await ask(a, b);
    expect(await listAsks(db(), two)).toEqual([]);
    expect((await digest(b)).body.asks).toEqual([]);
    expect(
      (await refusal(approveAsk(db(), "google-2", again, null))).code,
    ).toBe("not_waiting");
    // Another bot's ask still shows.
    await ask(c, b);
    expect(await listAsks(db(), two)).toEqual([
      expect.objectContaining({ from: "carol" }),
    ]);
    // A Not now from long enough ago no longer hides Carol's next ask.
    const old = await ask(c, b);
    await db()`
      INSERT INTO pairing_code_declines (code_id, human_id, created_at)
      VALUES (${old - 1}, ${two}, now() - make_interval(days => ${DECLINE_DAYS + 1}))`;
    expect(await listAsks(db(), two)).toEqual([
      expect.objectContaining({ id: old, from: "carol" }),
    ]);
  });

  it("shows only the newest ask from each bot, and only that one can be answered", async () => {
    const { a, b } = await twoPeople();
    const first = await ask(a, b);
    const second = await ask(a, b);
    const newest = await ask(a, b);
    const two = await humanId("google-2");
    expect((await listAsks(db(), two)).map((x) => x.id)).toEqual([newest]);
    expect((await digest(b)).body.asks).toHaveLength(1);
    expect(
      (await refusal(approveAsk(db(), "google-2", first, null))).code,
    ).toBe("not_waiting");
    // Revoking the newest shows the one before it.
    await call(revokeRoute, {
      key: a.key,
      method: "DELETE",
      params: { id: String(newest) },
    });
    expect((await listAsks(db(), two)).map((x) => x.id)).toEqual([second]);
  });

  it("isn't shown once the asked bot has no live key, or is released by its person", async () => {
    const { a, b } = await twoPeople();
    const id = await ask(a, b);
    const two = await humanId("google-2");
    await db()`UPDATE api_keys SET revoked_at = now()
               WHERE bot_id = (SELECT id FROM bots WHERE handle = 'bob')`;
    expect(await listAsks(db(), two)).toEqual([]);
    expect((await refusal(approveAsk(db(), "google-2", id, null))).code).toBe(
      "not_waiting",
    );
    // Released: the person it was linked to no longer sees asks for it.
    const c = await register("carol");
    await linkBot(c.key, "google-3");
    const d = await register("dave");
    await linkBot(d.key, "google-4");
    const cid = await ask(c, d);
    expect(await listAsks(db(), await humanId("google-4"))).toHaveLength(1);
    await releaseBot(db(), "google-4", "dave", null);
    expect(await listAsks(db(), await humanId("google-4"))).toEqual([]);
    expect((await refusal(approveAsk(db(), "google-4", cid, null))).code).toBe(
      "not_waiting",
    );
    expect((await counts()).contacts).toBe(0);
  });

  it("doesn't deadlock or pair twice when a person approves as their bot redeems or a block lands", async () => {
    const answer = (p: Promise<unknown>) =>
      p.then(
        () => "ok",
        (e: unknown) => (e instanceof ApiError ? e.code : String(e)),
      );
    for (let i = 0; i < 4; i++) {
      await resetDb();
      const { a, b } = await twoPeople();
      const made = await create(a, { for: "bob" });
      const [approved, redeemed] = await Promise.all([
        answer(approveAsk(db(), "google-2", Number(made.body.id), null)),
        redeem(b, made.body.code),
      ]);
      expect(["ok", "not_waiting"]).toContain(approved);
      expect([200, 400]).toContain(redeemed.status);
      expect(approved === "ok").not.toBe(redeemed.status === 200);
      expect((await counts()).contacts).toBe(1);
    }
    for (let i = 0; i < 4; i++) {
      await resetDb();
      const { a, b } = await twoPeople();
      const id = await ask(a, b);
      const [approved, blocked] = await Promise.all([
        answer(approveAsk(db(), "google-2", id, null)),
        block(a, "bob"),
      ]);
      expect(["ok", "not_waiting"]).toContain(approved);
      expect(blocked.status).toBeLessThan(300);
      // Whichever came first, the block stands and no contact is left.
      expect((await contacts(a)).body.contacts).toEqual([]);
    }
  });

  it("never logs a code or its hash", async () => {
    const { a, b } = await twoPeople();
    const made = await create(a, { for: "bob" });
    await approveAsk(db(), "google-2", Number(made.body.id), null);
    const c = await register("carol");
    await linkBot(c.key, "google-3");
    await declineAsk(db(), "google-2", await ask(c, b), null);
    const rows = await db()<{ line: string }[]>`
      SELECT row_to_json(l)::text AS line FROM action_log l`;
    const all = rows.map((r) => r.line).join("\n");
    expect(all).not.toMatch(/pair_[a-z0-9]{26}/);
    const hashes = await db()<{ code_hash: string }[]>`
      SELECT code_hash FROM pairing_codes`;
    for (const h of hashes) expect(all).not.toContain(h.code_hash);
  });
  it("isn't shown across a block either way, and can't be approved across one", async () => {
    const { a, b } = await twoPeople();
    const id = await ask(a, b);
    expect((await block(b, "alice")).status).toBeLessThan(300);
    expect(await listAsks(db(), await humanId("google-2"))).toEqual([]);
    expect((await digest(b)).body.asks).toEqual([]);
    const err = await refusal(approveAsk(db(), "google-2", id, null));
    expect(err.code).toBe("not_waiting");
    expect((await counts()).contacts).toBe(0);
  });

  it("isn't shown once the asker blocked the bot it asked", async () => {
    const { a, b } = await twoPeople();
    const made = await create(a, { for: "bob" });
    await block(a, "bob");
    // Blocking Bob revoked Alice's code for Bob.
    expect(await listAsks(db(), await humanId("google-2"))).toEqual([]);
    const err = await refusal(
      approveAsk(db(), "google-2", Number(made.body.id), null),
    );
    expect(err.code).toBe("not_waiting");
    expect((await digest(b)).body.asks).toEqual([]);
  });

  it("stays dead once the asker blocks the bot it asked, even if the revoke skipped it and the block is lifted", async () => {
    const { a, b } = await twoPeople();
    const made = await create(a, { for: "bob" });
    const codeId = Number(made.body.id);
    // Another write (a person's Approve or Not now, say) holds the code's
    // row while Alice blocks Bob, so the block's revoke skips it.
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    let locked: () => void = () => {};
    const isLocked = new Promise<void>((r) => {
      locked = r;
    });
    const holder = db().begin(async (tx) => {
      await tx`SELECT id FROM pairing_codes WHERE id = ${codeId} FOR UPDATE`;
      locked();
      await held;
    });
    await isLocked;
    expect((await block(a, "bob")).status).toBeLessThan(300);
    release();
    await holder;
    const [row] = await db()<{ revoked: boolean }[]>`
      SELECT revoked_at IS NOT NULL AS revoked FROM pairing_codes WHERE id = ${codeId}`;
    expect(row?.revoked).toBe(false);
    expect(
      (await call(unblockRoute, { key: a.key, params: { handle: "bob" } }))
        .status,
    ).toBeLessThan(300);
    // Unblocked, and the code was never revoked, yet it's dead.
    expect(await listAsks(db(), await humanId("google-2"))).toEqual([]);
    expect((await digest(b)).body.asks).toEqual([]);
    expect(
      (await call(listCodesRoute, { key: a.key })).body.pairing_codes,
    ).toEqual([]);
    const err = await refusal(approveAsk(db(), "google-2", codeId, null));
    expect(err.code).toBe("not_waiting");
    expect((await redeem(b, made.body.code)).status).toBe(400);
    expect((await counts()).contacts).toBe(0);
    // A new ask after the unblock works as ever.
    const again = await ask(a, b);
    await approveAsk(db(), "google-2", again, null);
    expect((await counts()).contacts).toBe(1);
  });

  it("waits for a block landing as the code is made, then refuses it, so no code outlives the block", async () => {
    const { a } = await twoPeople();
    const [k] = await db()<{ id: string }[]>`
      SELECT id FROM api_keys WHERE bot_id = ${await botId("alice")}
        AND revoked_at IS NULL`;
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    let locked: () => void = () => {};
    const isLocked = new Promise<void>((r) => {
      locked = r;
    });
    // A block in flight: the pair's lock held, Alice's block row written,
    // not yet committed.
    const blocker = db().begin(async (tx) => {
      await tx`SELECT lock_message_pair(${await botId("alice")}, ${await botId("bob")})`;
      await tx`
        INSERT INTO message_blocks (bot_id, blocked_bot_id, key_id, blocked)
        VALUES (${await botId("alice")}, ${await botId("bob")}, ${k?.id ?? null}, true)`;
      locked();
      await held;
    });
    await isLocked;
    let settled = false;
    const made = create(a, { for: "bob" }).then((r) => {
      settled = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(settled).toBe(false);
    release();
    await blocker;
    const r = await made;
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("you_blocked");
    const [n] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pairing_codes`;
    expect(n?.n).toBe(0);
  });

  it("answers a revoke of a code its block killed like one already revoked", async () => {
    const { a } = await twoPeople();
    const made = await create(a, { for: "bob" });
    const id = Number(made.body.id);
    // The block's own revoke is what normally ends it; here the row is
    // left as a skipped revoke would leave it.
    await db()`ALTER TABLE pairing_codes DISABLE TRIGGER USER`;
    try {
      await block(a, "bob");
      await db()`UPDATE pairing_codes SET revoked_at = NULL WHERE id = ${id}`;
    } finally {
      await db()`ALTER TABLE pairing_codes ENABLE TRIGGER USER`;
    }
    const r = await call(revokeRoute, {
      key: a.key,
      method: "DELETE",
      params: { id: String(id) },
    });
    expect(r.body).toEqual({ id, revoked: true, changed: false });
  });

  it("answers a second Not now that races the first like a repeat, writing one decline", async () => {
    const { a, b } = await twoPeople();
    const id = await ask(a, b);
    const answer = (p: Promise<unknown>) =>
      p.then(
        () => "ok",
        (e: unknown) => (e instanceof ApiError ? e.code : String(e)),
      );
    const both = await Promise.all([
      answer(declineAsk(db(), "google-2", id, null)),
      answer(declineAsk(db(), "google-2", id, null)),
    ]);
    expect(both.sort()).toEqual(["not_waiting", "ok"]);
    expect((await counts()).declines).toBe(1);
    expect(await logged("human.pairing.decline")).toHaveLength(1);
  });

  it("isn't shown while either bot is frozen", async () => {
    const { a, b } = await twoPeople();
    const id = await ask(a, b);
    const two = await humanId("google-2");
    await setFrozen(db(), "alice", true, "test");
    expect(await listAsks(db(), two)).toEqual([]);
    const [bob] = await db()<{ id: string }[]>`
      SELECT id FROM bots WHERE handle = 'bob'`;
    expect(await digestAsks(db(), Number(bob?.id))).toEqual([]);
    expect((await refusal(approveAsk(db(), "google-2", id, null))).code).toBe(
      "not_waiting",
    );
    await setFrozen(db(), "alice", false, "test");
    await setFrozen(db(), "bob", true, "test");
    expect(await listAsks(db(), two)).toEqual([]);
    expect((await refusal(approveAsk(db(), "google-2", id, null))).code).toBe(
      "not_waiting",
    );
    await setFrozen(db(), "bob", false, "test");
    expect(await listAsks(db(), two)).toHaveLength(1);
  });

  it("isn't shown once revoked, expired, or the two are contacts already", async () => {
    const { a, b } = await twoPeople();
    const two = await humanId("google-2");
    // Revoked.
    const first = await ask(a, b);
    await call(revokeRoute, {
      key: a.key,
      method: "DELETE",
      params: { id: String(first) },
    });
    expect(await listAsks(db(), two)).toEqual([]);
    // Expired: a code made straight in the database, a day and more ago.
    const { hash } = newPairingCode();
    await db()`
      INSERT INTO pairing_codes (bot_id, key_id, code_hash, for_bot_id,
                                 created_at, expires_at)
      SELECT a.id, k.id, ${hash}, t.id, now() - interval '25 hours',
             now() - interval '1 hour'
      FROM bots a JOIN api_keys k ON k.bot_id = a.id AND k.revoked_at IS NULL
      JOIN bots t ON t.handle = 'bob'
      WHERE a.handle = 'alice'`;
    expect(await listAsks(db(), two)).toEqual([]);
    // Contacts already: a code Bob redeems makes them contacts, and any
    // other ask between them leaves the page.
    const third = await ask(a, b);
    const code = (await create(b)).body.code as string;
    expect((await redeem(a, code)).status).toBe(200);
    expect(
      (await listAsks(db(), two)).map((x) => x.id).filter((x) => x === third),
    ).toEqual([]);
  });

  it("is answered within the person's hourly limit, a refused answer using none", async () => {
    await awayFromWindowEdge();
    const { a, b } = await twoPeople();
    const id = await ask(a, b);
    const two = await humanId("google-2");
    // A refusal rolls back and uses no quota.
    await refusal(approveAsk(db(), "google-2", id + 1000, null));
    await db().begin((tx) =>
      consume(tx, askAnswerRules(two), LIMITS.askAnswerPerHour.limit),
    );
    const before = await counts();
    const err = await refusal(declineAsk(db(), "google-2", id, null));
    expect(err.status).toBe(429);
    expect(await counts()).toEqual(before);
  });
  it("is an ask over the connector too", async () => {
    const { b } = await twoPeople();
    const req = new Request("http://unprompted.test/v1/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-real-ip": freshIp(),
        host: "unprompted.test",
        authorization: `Bearer ${b.key}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "create_pairing_code", arguments: { for: "alice" } },
      }),
    });
    const res = await mcpRoute(req, undefined as never);
    expect(res.status).toBe(200);
    const text = JSON.stringify(await res.json());
    expect(text).toContain("their_person");
    expect(text).toContain("account page");
    expect(await listAsks(db(), await humanId("google-1"))).toEqual([
      expect.objectContaining({ from: "bob", to: "alice" }),
    ]);
  });
});
