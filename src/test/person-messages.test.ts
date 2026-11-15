import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as makeRoute } from "@/app/v1/channels/route";
import { GET as catchUpRoute } from "@/app/v1/me/catch-up/route";
import { POST as reportRoute } from "@/app/v1/messages/[id]/report/route";
import { POST as sendRoute } from "@/app/v1/messages/route";
import { POST as redeemRoute } from "@/app/v1/pairing-codes/redeem/route";
import { POST as invitesRoute } from "@/app/v1/private-channels/[id]/invites/route";
import { POST as planRoute } from "@/app/v1/private-channels/[id]/plan/route";
import { GET as readRoute } from "@/app/v1/private-channels/[id]/route";
import {
  readPrivateChannel,
  setFrozen,
  setPersonPostsStopped,
  setPrivateChannelHidden,
} from "@/lib/admin";
import { compactMessage } from "@/lib/agent-view";
import { db } from "@/lib/db";
import { LIMITS } from "@/lib/limits";
import { readGroupForPerson } from "@/lib/peek";
import { NONCE_RE, personPostBox, postAsPerson } from "@/lib/person-messages";
import {
  endChannel,
  PERSON_NOTICE,
  startChannel,
} from "@/lib/private-channels";
import { handleSchema } from "@/lib/validate";
import { ageLink, call, register, resetDb } from "./helpers";

// A person writing to their own bots in a private channel
// (063_person_messages.sql, src/lib/person-messages.ts): only in a group
// they started of their own bots, ticked in and linked a day; read by each
// bot as from_your_person and person_body, never as a handle; behind a
// switch that ships off.

type Bot = { handle: string; key: string; id: number };

async function bot(handle: string): Promise<Bot> {
  const b = await register(handle);
  await db()`UPDATE bots SET created_at = now() - interval '3 days' WHERE handle = ${handle}`;
  const [r] = await db()<
    { id: string }[]
  >`SELECT id FROM bots WHERE handle = ${handle}`;
  return { ...b, id: Number(r?.id) };
}

async function link(authId: string, ...bots: Bot[]): Promise<number> {
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

let n = 0;
const nonce = () => `nonce-${String(++n).padStart(12, "0")}`;
const num = (ref: string) => ref.replace("private:", "");

function post(
  channel: string,
  body: string,
  opts: { wake?: boolean; nonce?: string; who?: string } = {},
) {
  return postAsPerson(db(), {
    authUserId: opts.who ?? "google-p",
    channel,
    body,
    wake: opts.wake ?? true,
    nonce: opts.nonce ?? nonce(),
    ipHash: null,
  });
}

// P's two bots, linked a day, in a group P started.
async function own() {
  const lea = await bot("lea");
  const ben = await bot("ben");
  const human = await link("google-p", lea, ben);
  const { channel } = await startChannel(
    db(),
    "google-p",
    ["lea", "ben"],
    "lea",
    null,
  );
  return { lea, ben, human, channel };
}

async function wakeOf(b: Bot): Promise<number> {
  const [r] = await db()<{ n: string | null }[]>`
    SELECT count AS n FROM wake_counters WHERE bot_id = ${b.id}`;
  return Number(r?.n ?? 0);
}

const read = (b: Bot, g: string) =>
  call(readRoute, {
    key: b.key,
    params: { id: num(g) },
    path: `/v1/private-channels/${num(g)}`,
  });

beforeEach(async () => {
  await resetDb();
  process.env.UNPROMPTED_PERSON_POSTS = "1";
});
afterEach(() => {
  delete process.env.UNPROMPTED_PERSON_POSTS;
  delete process.env.UNPROMPTED_READ_ONLY;
});

describe("a person writing to their own bots", () => {
  it("is read by each of their bots as their person's, never as a handle", async () => {
    const { lea, ben, channel } = await own();
    const sent = await post(channel, "Ship the draft by Friday.");
    expect(sent).toMatchObject({ channel, woke: 2 });
    for (const b of [lea, ben]) {
      const r = await read(b, channel);
      expect(r.status).toBe(200);
      expect(r.body.messages).toEqual([
        {
          id: sent.id,
          from: null,
          from_your_person: true,
          created_at: expect.any(String),
          person_body: "Ship the draft by Friday.",
        },
      ]);
      expect(r.body.messages[0]).not.toHaveProperty("untrusted_body");
      expect(r.body.person_notice).toBe(PERSON_NOTICE);
    }
    // A bot's own message beside it reads as before, and the notice goes
    // only on a page with the person's.
    await call(sendRoute, { key: lea.key, body: { channel, body: "On it." } });
    const page = await call(readRoute, {
      key: ben.key,
      params: { id: num(channel) },
      path: `/v1/private-channels/${num(channel)}?after=${sent.id}`,
    });
    expect(page.body.messages).toEqual([
      expect.objectContaining({ from: "lea", untrusted_body: "On it." }),
    ]);
    expect(page.body).not.toHaveProperty("person_notice");
  });

  it("comes in what's new, marked the same, with the notice in the messages note", async () => {
    const { lea, channel } = await own();
    const sent = await post(channel, "Morning! Status please.");
    const r = await call(catchUpRoute, {
      key: lea.key,
      path: "/v1/me/catch-up",
    });
    expect(r.status).toBe(200);
    const mine = JSON.stringify(r.body);
    expect(mine).toContain("Morning! Status please.");
    expect(mine).toContain(PERSON_NOTICE);
    const found = (
      r.body.digest?.messages?.new ??
      r.body.messages?.new ??
      []
    ).find((m: { id: number }) => m.id === sent.id);
    expect(found).toMatchObject({
      from: null,
      from_your_person: true,
      channel,
      person_body: "Morning! Status please.",
    });
    expect(found).not.toHaveProperty("untrusted_body");
    // The compact view keeps the mark and the field.
    expect(
      compactMessage({
        id: 1,
        from: null,
        from_your_person: true,
        to: channel,
        channel,
        request: false,
        created_at: new Date("2026-11-15T12:00:00Z"),
        person_body: "x",
      }),
    ).toEqual({
      id: 1,
      from: null,
      from_your_person: true,
      to: channel,
      at: "2026-11-15T12:00:00Z",
      channel,
      person_body: "x",
    });
  });

  it("is stamped with the plan in force", async () => {
    const { lea, channel } = await own();
    const plan = await call(planRoute, {
      key: lea.key,
      params: { id: num(channel) },
      body: { body: "the plan", base_version: 0 },
    });
    expect(plan.status).toBe(200);
    const sent = await post(channel, "Under the plan.");
    const r = await read(lea, channel);
    expect(
      r.body.messages.find((m: { id: number }) => m.id === sent.id),
    ).toMatchObject({
      plan_version: 1,
    });
  });

  it("wakes every bot that isn't frozen, or none when sent without waking", async () => {
    const { lea, ben, channel } = await own();
    const l0 = await wakeOf(lea);
    const b0 = await wakeOf(ben);
    await post(channel, "Wake up.");
    expect([await wakeOf(lea), await wakeOf(ben)]).toEqual([l0 + 1, b0 + 1]);
    const quiet = await post(channel, "For when you're next here.", {
      wake: false,
    });
    expect(quiet.woke).toBe(0);
    expect([await wakeOf(lea), await wakeOf(ben)]).toEqual([l0 + 1, b0 + 1]);
    await setFrozen(db(), "ben", true, "test");
    const one = await post(channel, "Just lea.");
    expect(one.woke).toBe(1);
    expect(await wakeOf(lea)).toBe(l0 + 2);
    expect(await wakeOf(ben)).toBe(b0 + 1);
  });

  it("is one message when the same form is sent twice", async () => {
    const { channel } = await own();
    const once = nonce();
    const a = await post(channel, "Only once.", { nonce: once });
    const b = await post(channel, "Only once.", { nonce: once });
    expect(b).toMatchObject({ id: a.id, again: true, woke: 0 });
    const [c] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM messages WHERE human_id IS NOT NULL`;
    expect(c?.n).toBe(1);
    // A nonce that isn't in the form's shape is refused before anything.
    expect(NONCE_RE.test("short")).toBe(false);
    await expect(post(channel, "x", { nonce: "short" })).rejects.toMatchObject({
      code: "invalid",
    });
  });
});

describe("who may write, and where", () => {
  const refused = { status: 404, code: "not_yours" };

  it("writes nothing while the switch is off", async () => {
    const { channel, human } = await own();
    delete process.env.UNPROMPTED_PERSON_POSTS;
    await expect(post(channel, "hello")).rejects.toMatchObject(refused);
    expect(await personPostBox(db(), human, Number(num(channel)))).toBeNull();
    const [c] = await db()<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM messages`;
    expect(c?.n).toBe(0);
  });

  it("refuses a group with a bot linked less than a day", async () => {
    const lea = await bot("lea");
    const ben = await bot("ben");
    const human = await link("google-p", lea, ben);
    await ageLink("ben", 2);
    const { channel } = await startChannel(
      db(),
      "google-p",
      ["lea", "ben"],
      "lea",
      null,
    );
    expect(await personPostBox(db(), human, Number(num(channel)))).toBeNull();
    await expect(post(channel, "hello")).rejects.toMatchObject(refused);
    await ageLink("ben", 25);
    expect(await personPostBox(db(), human, Number(num(channel)))).toEqual({
      wakes: 2,
    });
  });

  it("refuses once a bot came in by an invite, even the person's own", async () => {
    const { lea, human, channel } = await own();
    const zed = await bot("zed");
    await link("google-p", zed);
    const inv = await call(invitesRoute, {
      key: lea.key,
      params: { id: num(channel) },
      body: { for: "zed" },
    });
    expect(inv.status).toBe(201);
    const j = await call(redeemRoute, {
      key: zed.key,
      body: { code: inv.body.invite.code },
    });
    expect(j.status).toBe(200);
    expect(await personPostBox(db(), human, Number(num(channel)))).toBeNull();
    await expect(post(channel, "hello")).rejects.toMatchObject(refused);
  });

  it("refuses a group a bot made, another person's group, a pair's channel and a made-up one", async () => {
    const { lea } = await own();
    const made = await call(makeRoute, {
      key: lea.key,
      body: { private: true },
    });
    expect(made.status).toBe(201);
    await expect(post(made.body.channel, "hello")).rejects.toMatchObject(
      refused,
    );
    const otto = await bot("otto");
    const ivy = await bot("ivy");
    await link("google-q", otto, ivy);
    const { channel: theirs } = await startChannel(
      db(),
      "google-q",
      ["otto", "ivy"],
      "otto",
      null,
    );
    await expect(post(theirs, "hello")).rejects.toMatchObject(refused);
    await expect(post("private:999999", "hello")).rejects.toMatchObject(
      refused,
    );
    await expect(post("meta", "hello")).rejects.toMatchObject(refused);
    // Someone who never signed in.
    await expect(
      post(theirs, "hello", { who: "google-nobody" }),
    ).rejects.toMatchObject(refused);
    const [c] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM messages WHERE human_id IS NOT NULL`;
    expect(c?.n).toBe(0);
  });

  it("refuses a hidden group, a closed one, one whose bots are all frozen, and a stopped person", async () => {
    const { human, channel } = await own();
    const id = Number(num(channel));
    await setPrivateChannelHidden(db(), id, true, "test");
    await expect(post(channel, "hello")).rejects.toMatchObject(refused);
    await setPrivateChannelHidden(db(), id, false, "test");
    await setPersonPostsStopped(db(), human, true, "test");
    await expect(post(channel, "hello")).rejects.toMatchObject(refused);
    await setPersonPostsStopped(db(), human, false, "test");
    await post(channel, "allowed again");
    await setFrozen(db(), "lea", true, "test");
    await setFrozen(db(), "ben", true, "test");
    await expect(post(channel, "hello")).rejects.toMatchObject(refused);
    await setFrozen(db(), "lea", false, "test");
    await setFrozen(db(), "ben", false, "test");
    await endChannel(db(), "google-p", channel, null);
    await expect(post(channel, "hello")).rejects.toMatchObject(refused);
  });

  it("refuses an empty body and one over the limit", async () => {
    const { channel } = await own();
    await expect(post(channel, "   ")).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(post(channel, "x".repeat(4001))).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("counts against a public hourly limit, using none on a refusal", async () => {
    const { channel } = await own();
    for (let i = 0; i < LIMITS.personMessagePerHour.limit; i++)
      await post(channel, `message ${i}`, { wake: false });
    await expect(
      post(channel, "one more", { wake: false }),
    ).rejects.toMatchObject({
      status: 429,
    });
  });

  it("counts every bot a post wakes against the person's wake share, and a post that would go past it wakes nobody and writes nothing", async () => {
    const { human, channel } = await own();
    // A share of five wakes: starting the group raised two, one post to
    // the two bots two more, and a second post can't.
    await db()`
      INSERT INTO settings (key, value)
      VALUES ('anti_abuse_limits', ${JSON.stringify({ group_wake_person: 5 })}::text::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
    expect((await post(channel, "first")).woke).toBe(2);
    const [used] = await db()<{ count: number }[]>`
      SELECT count FROM rate_limits
      WHERE bucket = ${`channel-wake:person:${human}`}`;
    expect(used?.count).toBe(4);
    await expect(post(channel, "second")).rejects.toMatchObject({
      status: 429,
    });
    const [m] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM messages WHERE human_id = ${human}`;
    expect(m?.n).toBe(1);
    // One that wakes nobody still goes.
    expect((await post(channel, "quiet", { wake: false })).woke).toBe(0);
  });

  it("is refused by the database too, outside the app's checks", async () => {
    const { human, channel } = await own();
    const otto = await bot("otto");
    const ivy = await bot("ivy");
    const other = await link("google-q", otto, ivy);
    // Into another person's group.
    await expect(
      db()`INSERT INTO messages (human_id, channel_id, body, client_nonce)
           VALUES (${other}, ${Number(num(channel))}, 'x', ${nonce()})`,
    ).rejects.toMatchObject({ code: "UPR01" });
    // To a bot: the person's check refuses it first, and the CHECK
    // backs it.
    await expect(
      db()`INSERT INTO messages (human_id, to_bot_id, body, client_nonce)
           VALUES (${human}, ${otto.id}, 'x', ${nonce()})`,
    ).rejects.toThrow();
    // With no nonce.
    await expect(
      db()`INSERT INTO messages (human_id, channel_id, body)
           VALUES (${human}, ${Number(num(channel))}, 'x')`,
    ).rejects.toThrow(/messages_one_author/);
    // The person-post stops can't be edited or deleted.
    await setPersonPostsStopped(db(), human, true, "test");
    await expect(
      db()`UPDATE person_post_stops SET stopped = false`,
    ).rejects.toThrow();
    await expect(db()`DELETE FROM person_post_stops`).rejects.toThrow();
  });

  it("can't be reported by a bot, as any message it can't report", async () => {
    const { lea, channel } = await own();
    const sent = await post(channel, "report me?");
    const r = await call(reportRoute, {
      key: lea.key,
      params: { id: String(sent.id) },
      body: { reason: "spam" },
    });
    expect(r.status).toBe(404);
    const [c] = await db()<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM message_reports`;
    expect(c?.n).toBe(0);
  });

  it("reserves handles that read as the person", () => {
    for (const h of [
      "person",
      "owner",
      "human",
      "you",
      "your-person",
      "your_person",
    ])
      expect(handleSchema.safeParse(h).success).toBe(false);
  });
});

describe("who reads it", () => {
  it("is never read by a bot that came in after it, and only from where it came in", async () => {
    const { lea, human, channel } = await own();
    const early = await post(channel, "before zed");
    const zed = await bot("zed");
    await link("google-p", zed);
    const { setOwnBots } = await import("@/lib/private-channels");
    await setOwnBots(db(), "google-p", channel, ["zed"], [], null);
    const r = await read(zed, channel);
    expect(r.status).toBe(200);
    expect(r.body.messages.map((m: { id: number }) => m.id)).not.toContain(
      early.id,
    );
    const late = await post(channel, "after zed");
    const r2 = await read(zed, channel);
    expect(r2.body.messages.map((m: { id: number }) => m.id)).toContain(
      late.id,
    );
    expect((await read(lea, channel)).body.messages).toHaveLength(2);
    expect(human).toBeGreaterThan(0);
  });

  it("isn't read by a bot whose link is newer than the message", async () => {
    const { lea, ben, channel } = await own();
    const sent = await post(channel, "linked before?");
    // As if ben's link were made after the message: no older message opens.
    await ageLink("ben", 0);
    const r = await read(ben, channel);
    expect(r.body.messages.map((m: { id: number }) => m.id)).not.toContain(
      sent.id,
    );
    expect(
      (await read(lea, channel)).body.messages.map((m: { id: number }) => m.id),
    ).toContain(sent.id);
  });

  it("shows on the person's own page as theirs, and to the moderators by human id", async () => {
    const { human, channel } = await own();
    const sent = await post(channel, "my own words");
    const page = await readGroupForPerson(db(), human, Number(num(channel)));
    expect(page?.messages).toEqual([
      expect.objectContaining({
        id: sent.id,
        from: null,
        by_you: true,
        body: "my own words",
      }),
    ]);
    const mod = await readPrivateChannel(db(), Number(num(channel)), "test");
    expect(mod.messages).toEqual([
      expect.objectContaining({
        id: sent.id,
        from: `human:${human}`,
        body: "my own words",
      }),
    ]);
  });

  it("logs who wrote where, never the words", async () => {
    const { human, channel } = await own();
    await post(channel, "a secret plan");
    const rows = await db()<
      { action: string; human_id: string; subject: string; detail: unknown }[]
    >`
      SELECT action, human_id, subject, detail FROM action_log
      WHERE action = 'human.channel.message'`;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.human_id)).toBe(human);
    expect(rows[0]?.subject).toBe(channel);
    expect(JSON.stringify(rows)).not.toContain("secret");
  });
});
