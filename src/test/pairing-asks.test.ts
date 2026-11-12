import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as blockRoute } from "@/app/v1/bots/[handle]/block/route";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { GET as contactsRoute } from "@/app/v1/me/contacts/route";
import { GET as digestRoute } from "@/app/v1/me/digest/route";
import { DELETE as revokeRoute } from "@/app/v1/me/pairing-codes/[id]/route";
import { POST as createRoute } from "@/app/v1/me/pairing-codes/route";
import { POST as sendRoute } from "@/app/v1/messages/route";
import { POST as redeemRoute } from "@/app/v1/pairing-codes/redeem/route";
import { setFrozen, setGates } from "@/lib/admin";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/http";
import { findHuman } from "@/lib/humans";
import { newPairingCode } from "@/lib/keys";
import { LIMITS } from "@/lib/limits";
import {
  approveAsk,
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
// Between two bots of the same person it pairs at once. Every ask that
// can't be answered gets the same refusal, only the person a bot is linked
// to can answer for it, and every refusal writes nothing.

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

  it("pairs two bots of the same person at once, with nothing to pass on", async () => {
    const a = await register("alice");
    const b = await register("bob");
    await linkBot(a.key, "google-1");
    await linkBot(b.key, "google-1");
    const made = await create(a, { for: "bob" });
    expect(made.status).toBe(201);
    expect(made.body.approval).toBe("paired");
    expect(made.body.contact).toMatchObject({ handle: "bob" });
    expect(made.body.note).toMatch(/paired already/);
    expect((await contacts(b)).body.contacts).toEqual([
      expect.objectContaining({ handle: "alice", method: "code" }),
    ]);
    expect((await counts()).used).toBe(1);
    // Logged as a redeem by Bob, on the same person's word.
    expect(await logged("pairing.redeem")).toEqual([
      expect.objectContaining({
        bot: "bob",
        detail: expect.objectContaining({ via: "same_person" }),
      }),
    ]);
    // The code is spent: nobody can redeem it again.
    expect((await redeem(b, made.body.code)).body.error.code).toBe(
      "invalid_code",
    );
    expect(await listAsks(db(), await humanId("google-1"))).toEqual([]);
    // And they can write each other with closed inboxes.
    expect((await send(b, "alice", "hi")).status).toBe(201);
  });

  it("falls back to an ask when the other bot of the same person may not pair yet", async () => {
    const a = await register("alice");
    const b = await register("bob");
    await linkBot(a.key, "google-1");
    await linkBot(b.key, "google-1");
    await db()`UPDATE bots SET created_at = now() - interval '30 days'
               WHERE handle = 'alice'`;
    await setGates(db(), { pair: [{ signal: "is_new", is: false }] }, "test");
    const made = await create(a, { for: "bob" });
    expect(made.status).toBe(201);
    expect(made.body.approval).toBe("their_person");
    expect((await counts()).contacts).toBe(0);
    // Approving runs the same gate for Bob, and refuses without writing.
    const before = await counts();
    const err = await refusal(
      approveAsk(db(), "google-1", Number(made.body.id), null),
    );
    expect(err.code).toBe("not_yet");
    expect(await counts()).toEqual(before);
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
    await declineAsk(db(), "google-2", id, null);
    expect((await counts()).declines).toBe(1);
    expect(await logged("human.pairing.decline")).toHaveLength(1);
    expect(await listAsks(db(), two)).toEqual([]);
    expect((await digest(b)).body.asks).toEqual([]);
    // Alice's code is still waiting, as far as she can tell.
    const [row] = await db()<
      { redeemed_at: Date | null; revoked_at: Date | null }[]
    >`
      SELECT redeemed_at, revoked_at FROM pairing_codes WHERE id = ${id}`;
    expect(row).toEqual({ redeemed_at: null, revoked_at: null });
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
    // A refusal rolls back and uses no quota.
    await refusal(approveAsk(db(), "google-2", id + 1000, null));
    for (let i = 0; i < LIMITS.askAnswerPerHour.limit; i++)
      await declineAsk(db(), "google-2", id, null);
    const err = await refusal(declineAsk(db(), "google-2", id, null));
    expect(err.status).toBe(429);
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
