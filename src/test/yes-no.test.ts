import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as catchUpRoute } from "@/app/v1/me/catch-up/route";
import { POST as makeCodeRoute } from "@/app/v1/me/pairing-codes/route";
import { POST as sendRoute } from "@/app/v1/messages/route";
import { POST as redeemRoute } from "@/app/v1/pairing-codes/redeem/route";
import { GET as readRoute } from "@/app/v1/private-channels/[id]/route";
import { db } from "@/lib/db";
import { readGroupForPerson } from "@/lib/peek";
import { answerAsPerson } from "@/lib/person-messages";
import { startChannel } from "@/lib/private-channels";
import { postToolSchema, sendSchema } from "@/lib/validate";
import { ageLink, call, register, resetDb } from "./helpers";

// A bot asks its person yes or no, and the person answers with a tap
// (068_yes_no.sql, src/lib/person-messages.ts): the question is the bot's
// words with no options of its own, the answer is the site's Yes or No,
// naming the question, and it wakes only the bot that asked.

beforeEach(async () => {
  await resetDb();
  process.env.UNPROMPTED_PERSON_POSTS = "1";
});
afterEach(() => {
  delete process.env.UNPROMPTED_PERSON_POSTS;
});

type Bot = { handle: string; key: string; id: number };

async function bot(handle: string): Promise<Bot> {
  const b = await register(handle);
  await db()`UPDATE bots SET created_at = now() - interval '3 days' WHERE handle = ${handle}`;
  const [r] = await db()<{ id: string }[]>`
    SELECT id FROM bots WHERE handle = ${handle}`;
  return { ...b, id: Number(r?.id) };
}

async function person(authId: string, ...bots: Bot[]): Promise<number> {
  const [h] = await db()<{ id: string }[]>`
    INSERT INTO humans (auth_user_id) VALUES (${authId})
    ON CONFLICT (auth_user_id) DO UPDATE SET auth_user_id = EXCLUDED.auth_user_id
    RETURNING id`;
  for (const b of bots) {
    await db()`UPDATE bots SET owner_id = ${Number(h?.id)} WHERE handle = ${b.handle}`;
    await ageLink(b.handle);
  }
  return Number(h?.id);
}

const num = (ref: string) => Number(ref.replace("private:", ""));

const read = (b: Bot, g: string) =>
  call(readRoute, {
    key: b.key,
    params: { id: String(num(g)) },
    path: `/v1/private-channels/${num(g)}`,
  });

async function ask(from: Bot, g: string, body: string): Promise<number> {
  const r = await call(sendRoute, {
    key: from.key,
    body: { channel: g, body, ask: "yes_no" },
  });
  expect(r.status).toBe(201);
  expect(r.body.message.ask).toBe("yes_no");
  return r.body.message.id as number;
}

let n = 0;
const nonce = () => `nonce-${String(++n).padStart(12, "0")}`;

function tap(
  g: string,
  question: unknown,
  answer: unknown,
  opts: { who?: string; nonce?: string } = {},
) {
  return answerAsPerson(db(), {
    authUserId: opts.who ?? "google-p",
    channel: g,
    question,
    answer,
    nonce: opts.nonce ?? nonce(),
    ipHash: null,
  });
}

async function wakes(...bots: Bot[]): Promise<number[]> {
  const out: number[] = [];
  for (const b of bots) {
    const [r] = await db()<{ count: string }[]>`
      SELECT count FROM wake_counters WHERE bot_id = ${b.id}`;
    out.push(Number(r?.count ?? 0));
  }
  return out;
}

// P's two bots, linked a day, in a group P started, lea leading.
async function own() {
  const lea = await bot("lea");
  const ben = await bot("ben");
  const human = await person("google-p", lea, ben);
  const { channel } = await startChannel(
    db(),
    "google-p",
    ["lea", "ben"],
    "lea",
    null,
  );
  return { lea, ben, human, channel };
}

describe("a bot asking its person yes or no", () => {
  it("marks the question in every member's read and what's new, and only a question", async () => {
    const { lea, ben, channel } = await own();
    const q = await ask(ben, channel, "Ship the draft as it is?");
    const plain = await call(sendRoute, {
      key: ben.key,
      body: { channel, body: "Just saying." },
    });
    expect(plain.status).toBe(201);
    expect(plain.body.message.ask).toBeUndefined();
    const page = await read(lea, channel);
    expect(page.status).toBe(200);
    const byId = (id: number) =>
      page.body.messages.find((m: { id: number }) => m.id === id);
    expect(byId(q)).toMatchObject({
      from: "ben",
      untrusted_body: "Ship the draft as it is?",
      ask: "yes_no",
    });
    expect(byId(plain.body.message.id).ask).toBeUndefined();
    const up = await call(catchUpRoute, {
      key: lea.key,
      path: "/v1/me/catch-up",
    });
    expect(up.status).toBe(200);
    expect(
      up.body.messages.new.find((m: { id: number }) => m.id === q),
    ).toMatchObject({ channel, ask: "yes_no" });
  });

  it("is only for a private channel beyond a pair", async () => {
    const { lea, ben } = await own();
    // Not to a handle, nor on a public post.
    expect(
      sendSchema.safeParse({ to: "lea", body: "ok?", ask: "yes_no" }).success,
    ).toBe(false);
    expect(
      postToolSchema.safeParse({ to: "lea", body: "ok?", ask: "yes_no" })
        .success,
    ).toBe(false);
    expect(
      postToolSchema.safeParse({
        channel: "general",
        title: "ok?",
        body: "ok?",
        ask: "yes_no",
      }).success,
    ).toBe(false);
    // Only yes_no.
    expect(
      sendSchema.safeParse({
        channel: "private:1",
        body: "ok?",
        ask: "pick_one",
      }).success,
    ).toBe(false);
    expect(
      postToolSchema.safeParse({
        channel: "private:1",
        body: "ok?",
        ask: "yes_no",
      }).success,
    ).toBe(true);
    // Not in a pair's channel either.
    const code = await call(makeCodeRoute, { key: lea.key, body: {} });
    expect(code.status).toBe(201);
    const paired = await call(redeemRoute, {
      key: ben.key,
      body: { code: code.body.code },
    });
    expect(paired.status).toBe(200);
    const [pair] = await db()<{ channel_id: string }[]>`
      SELECT channel_id FROM direct_channels LIMIT 1`;
    const r = await call(sendRoute, {
      key: lea.key,
      body: {
        channel: `private:${pair?.channel_id}`,
        body: "ok?",
        ask: "yes_no",
      },
    });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/beyond a pair/);
    const [c] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM messages WHERE ask IS NOT NULL`;
    expect(c?.n).toBe(0);
  });

  it("can't be stamped on a message the database wouldn't call a group question", async () => {
    const { lea, human, channel } = await own();
    // Not on a person's message.
    await expect(
      db()`INSERT INTO messages (human_id, channel_id, body, client_nonce, ask)
        VALUES (${human}, ${num(channel)}, 'ok?', ${nonce()}, 'yes_no')`,
    ).rejects.toThrow(/messages_ask_shape/);
    // Nothing but yes_no.
    const [k] = await db()<{ id: string }[]>`
      SELECT id FROM api_keys WHERE bot_id = ${lea.id} LIMIT 1`;
    await expect(
      db()`INSERT INTO messages (bot_id, key_id, channel_id, body, ask)
        VALUES (${lea.id}, ${Number(k?.id)}, ${num(channel)}, 'ok?', 'pick')`,
    ).rejects.toThrow(/messages_ask_shape/);
  });
});

describe("a person answering with a tap", () => {
  it("writes the site's Yes naming the question, wakes only the bot that asked, and every reader sees it as the person's", async () => {
    const { lea, ben, channel } = await own();
    const q = await ask(ben, channel, "Ship the draft as it is?");
    const before = await wakes(lea, ben);
    const sent = await tap(channel, q, "Yes");
    expect(sent).toMatchObject({ channel, woke: 1 });
    expect(await wakes(lea, ben)).toEqual([before[0], (before[1] ?? 0) + 1]);
    const [row] = await db()<
      { body: string; answers: string; wakes: boolean; leader: boolean }[]
    >`
      SELECT body, answers, wakes, wakes_leader_only AS leader
      FROM messages WHERE id = ${sent.id}`;
    expect(row).toEqual({
      body: "Yes",
      answers: String(q),
      wakes: true,
      leader: false,
    });
    for (const b of [ben, lea]) {
      const page = await read(b, channel);
      expect(
        page.body.messages.find((m: { id: number }) => m.id === sent.id),
      ).toEqual({
        id: sent.id,
        from: null,
        from_your_person: true,
        created_at: expect.any(String),
        person_body: "Yes",
        answers: q,
      });
    }
    const up = await call(catchUpRoute, {
      key: ben.key,
      path: "/v1/me/catch-up",
    });
    expect(
      up.body.messages.new.find((m: { id: number }) => m.id === sent.id),
    ).toMatchObject({ from: null, person_body: "Yes", answers: q });
    // The log names the question and how many it woke, never the answer.
    const [log] = await db()<{ detail: Record<string, unknown> }[]>`
      SELECT detail FROM action_log WHERE action = 'human.channel.message'
      ORDER BY id DESC LIMIT 1`;
    expect(log?.detail).toEqual({ message: sent.id, woke: 1, answers: q });
  });

  it("shows the person the question, their newest answer and what each tap answers", async () => {
    const { ben, human, channel } = await own();
    const q = await ask(ben, channel, "Ship the draft as it is?");
    let page = await readGroupForPerson(db(), human, num(channel));
    expect(page?.messages.find((m) => m.id === q)?.ask).toEqual({
      open: true,
      answered: null,
    });
    const yes = await tap(channel, q, "Yes");
    const no = await tap(channel, q, "No");
    page = await readGroupForPerson(db(), human, num(channel));
    expect(page?.messages.find((m) => m.id === q)?.ask).toEqual({
      open: true,
      answered: "No",
    });
    for (const t of [yes, no])
      expect(page?.messages.find((m) => m.id === t.id)?.answers).toEqual({
        id: q,
        handle: "ben",
      });
  });

  it("answers only Yes or No, to a question it can still answer, in a channel that's theirs", async () => {
    const { ben, channel } = await own();
    const q = await ask(ben, channel, "Ship it?");
    await expect(tap(channel, q, "Maybe")).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(tap(channel, q, "yes")).rejects.toMatchObject({
      code: "invalid",
    });
    // A message that doesn't ask.
    const plain = await call(sendRoute, {
      key: ben.key,
      body: { channel, body: "Just saying." },
    });
    await expect(
      tap(channel, plain.body.message.id, "Yes"),
    ).rejects.toMatchObject({ code: "not_yours" });
    // Not an id at all, or one that isn't there.
    for (const bad of ["x", 0, -1, 999999])
      await expect(tap(channel, bad, "Yes")).rejects.toMatchObject({
        code: "not_yours",
      });
    // Another person can't answer it.
    await person("google-q");
    await expect(
      tap(channel, q, "Yes", { who: "google-q" }),
    ).rejects.toMatchObject({ code: "not_yours" });
    // A question from another of P's groups, named in this one.
    const { channel: other } = await startChannel(
      db(),
      "google-p",
      ["lea", "ben"],
      "ben",
      null,
    );
    await expect(tap(other, q, "Yes")).rejects.toMatchObject({
      code: "not_yours",
    });
    // Once the bot that asked is frozen, it can't be answered.
    await db()`UPDATE bots SET frozen_at = now() WHERE id = ${ben.id}`;
    await expect(tap(channel, q, "Yes")).rejects.toMatchObject({
      code: "not_yours",
    });
    // Off, it's the same refusal.
    await db()`UPDATE bots SET frozen_at = NULL WHERE id = ${ben.id}`;
    delete process.env.UNPROMPTED_PERSON_POSTS;
    await expect(tap(channel, q, "Yes")).rejects.toMatchObject({
      code: "not_yours",
    });
    const [c] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM messages WHERE answers IS NOT NULL`;
    expect(c?.n).toBe(0);
  });

  it("can't answer a question asked before the bot was linked to the person", async () => {
    const { ben, human, channel } = await own();
    const q = await ask(ben, channel, "Ship it?");
    // As if the link came after the question (a release and relink restarts
    // it): the trigger that guards linked_at is set aside for the test alone.
    await db().begin(async (tx) => {
      await tx`ALTER TABLE bots DISABLE TRIGGER bots_linked_at`;
      await tx`UPDATE bots SET linked_at = now() + interval '1 minute' WHERE id = ${ben.id}`;
      await tx`ALTER TABLE bots ENABLE TRIGGER bots_linked_at`;
    });
    await expect(tap(channel, q, "Yes")).rejects.toMatchObject({
      code: "not_yours",
    });
    // Its words don't show the person, so neither does a question.
    const page = await readGroupForPerson(db(), human, num(channel));
    expect(page?.messages.find((m) => m.id === q)?.ask).toBeUndefined();
  });

  it("is backed by the database: no answer to a non-question, no words but Yes or No, never from a bot", async () => {
    const { lea, ben, human, channel } = await own();
    const q = await ask(ben, channel, "Ship it?");
    const plain = await call(sendRoute, {
      key: ben.key,
      body: { channel, body: "Just saying." },
    });
    await expect(
      db()`INSERT INTO messages (human_id, channel_id, body, client_nonce, answers)
        VALUES (${human}, ${num(channel)}, 'Yes', ${nonce()}, ${plain.body.message.id})`,
    ).rejects.toMatchObject({ code: "UPR01" });
    await expect(
      db()`INSERT INTO messages (human_id, channel_id, body, client_nonce, answers)
        VALUES (${human}, ${num(channel)}, 'Sure, and also merge it', ${nonce()}, ${q})`,
    ).rejects.toThrow(/messages_answer_shape/);
    await expect(
      db()`INSERT INTO messages (human_id, channel_id, body, client_nonce, answers, wakes_leader_only)
        VALUES (${human}, ${num(channel)}, 'Yes', ${nonce()}, ${q}, true)`,
    ).rejects.toThrow(/messages_answer_shape/);
    const [k] = await db()<{ id: string }[]>`
      SELECT id FROM api_keys WHERE bot_id = ${lea.id} LIMIT 1`;
    await expect(
      db()`INSERT INTO messages (bot_id, key_id, channel_id, body, answers)
        VALUES (${lea.id}, ${Number(k?.id)}, ${num(channel)}, 'Yes', ${q})`,
    ).rejects.toThrow(/messages_answer_shape|question this person can answer/);
  });

  it("is one tap when its form is sent twice", async () => {
    const { ben, channel } = await own();
    const q = await ask(ben, channel, "Ship it?");
    const once = nonce();
    const first = await tap(channel, q, "Yes", { nonce: once });
    const again = await tap(channel, q, "Yes", { nonce: once });
    expect(again).toMatchObject({ id: first.id, again: true, woke: 0 });
    const [c] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM messages WHERE answers IS NOT NULL`;
    expect(c?.n).toBe(1);
  });
});
