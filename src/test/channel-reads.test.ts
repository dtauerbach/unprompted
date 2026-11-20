import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as makeRoute } from "@/app/v1/channels/route";
import { GET as catchUpRoute } from "@/app/v1/me/catch-up/route";
import { POST as sendRoute } from "@/app/v1/messages/route";
import { POST as redeemRoute } from "@/app/v1/pairing-codes/redeem/route";
import { POST as invitesRoute } from "@/app/v1/private-channels/[id]/invites/route";
import { GET as readRoute } from "@/app/v1/private-channels/[id]/route";
import { noteReads } from "@/lib/channel-reads";
import { db } from "@/lib/db";
import { readGroupForPerson } from "@/lib/peek";
import { startChannel } from "@/lib/private-channels";
import { ageLink, call, register, resetDb } from "./helpers";

// When each bot last read a group (067_channel_reads.sql,
// src/lib/channel-reads.ts): noted after its own read of the group and
// after a page of what's new that held the group's messages; shown only on
// its own person's chat page, under their newest message and beside each
// of their bots.

beforeEach(resetDb);
afterEach(() => {
  delete process.env.UNPROMPTED_READ_ONLY;
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

const read = (b: Bot, g: string, query = "") =>
  call(readRoute, {
    key: b.key,
    params: { id: String(num(g)) },
    path: `/v1/private-channels/${num(g)}${query}`,
  });

const send = async (from: Bot, g: string, body: string): Promise<number> => {
  const r = await call(sendRoute, {
    key: from.key,
    body: { channel: g, body },
  });
  expect(r.status).toBe(201);
  return r.body.message.id as number;
};

async function row(g: string, b: Bot) {
  const [r] = await db()<
    {
      read_upto: string;
      read_at: Date;
      person_upto: string;
      person_at: Date | null;
    }[]
  >`
    SELECT read_upto, read_at, person_upto, person_at FROM channel_reads
    WHERE channel_id = ${num(g)} AND bot_id = ${b.id}`;
  return r
    ? {
        upto: Number(r.read_upto),
        at: r.read_at,
        person: Number(r.person_upto),
        person_at: r.person_at,
      }
    : undefined;
}

// P's two bots in a group P started.
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

let n = 0;
async function personSays(human: number, g: string, body: string) {
  const nonce = `nonce-${String(++n).padStart(12, "0")}`;
  const [m] = await db()<{ id: string }[]>`
    INSERT INTO messages (human_id, channel_id, body, client_nonce)
    VALUES (${human}, ${num(g)}, ${body}, ${nonce})
    RETURNING id`;
  return Number(m?.id);
}

describe("noting a bot's reads of a group", () => {
  it("notes how far a bot's own read went and when, never going back", async () => {
    const { lea, ben, channel } = await own();
    expect(await row(channel, ben)).toBeUndefined();
    const m1 = await send(lea, channel, "one");
    const m2 = await send(lea, channel, "two");
    expect((await read(ben, channel)).status).toBe(200);
    const first = await row(channel, ben);
    expect(first?.upto).toBe(m2);
    // Paging back reads older messages: how far it read doesn't fall.
    expect((await read(ben, channel, `?before=${m2}`)).status).toBe(200);
    expect((await row(channel, ben))?.upto).toBe(m2);
    // A read with nothing new inside a minute writes nothing.
    expect((await read(ben, channel)).status).toBe(200);
    expect((await row(channel, ben))?.at).toEqual(first?.at);
    // A minute on, the time moves even with nothing new.
    await db().begin(async (tx) => {
      await tx`ALTER TABLE channel_reads DISABLE TRIGGER channel_reads_only_up`;
      await tx`UPDATE channel_reads SET read_at = now() - interval '2 minutes'
        WHERE bot_id = ${ben.id}`;
      await tx`ALTER TABLE channel_reads ENABLE TRIGGER channel_reads_only_up`;
    });
    const before = (await row(channel, ben))?.at;
    expect((await read(ben, channel)).status).toBe(200);
    const after = await row(channel, ben);
    expect(after?.upto).toBe(m2);
    expect(after?.at.getTime()).toBeGreaterThan(before?.getTime() ?? 0);
    expect(m1).toBeLessThan(m2);
  });

  it("notes a group whose messages a page of what's new gave, and only that", async () => {
    const { lea, ben, channel } = await own();
    const m = await send(lea, channel, "news");
    const r = await call(catchUpRoute, {
      key: ben.key,
      path: "/v1/me/catch-up",
    });
    expect(r.status).toBe(200);
    expect((await row(channel, ben))?.upto).toBe(m);
    // Its own message isn't in what's new: the sender's read isn't noted.
    expect(await row(channel, lea)).toBeUndefined();
    // Only the one group the page held is noted.
    const [all] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM channel_reads`;
    expect(all?.n).toBe(1);
  });

  it("notes nothing under the kill switch, nor for a channel that isn't a group", async () => {
    const { lea, ben, channel } = await own();
    await send(lea, channel, "hello");
    process.env.UNPROMPTED_READ_ONLY = "1";
    expect((await read(ben, channel)).status).toBe(200);
    expect(
      (await call(catchUpRoute, { key: ben.key, path: "/v1/me/catch-up" }))
        .status,
    ).toBe(200);
    expect(await row(channel, ben)).toBeUndefined();
    delete process.env.UNPROMPTED_READ_ONLY;
    // An id with no group behind it (a pair's, or none) is never noted.
    await noteReads(ben.id, new Map([[999999, { upto: 1, person: 1 }]]));
    const [c] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM channel_reads`;
    expect(c?.n).toBe(0);
  });

  it("only ever moves forward, and is never deleted", async () => {
    const { lea, ben, channel } = await own();
    await send(lea, channel, "hello");
    await read(ben, channel);
    await expect(
      db()`UPDATE channel_reads SET read_upto = 0 WHERE bot_id = ${ben.id}`,
    ).rejects.toThrow(/only moves forward/);
    await expect(
      db()`DELETE FROM channel_reads WHERE bot_id = ${ben.id}`,
    ).rejects.toThrow(/never deleted/);
  });
});

describe("noting only what a person can see", () => {
  it("notes nothing for a bot no person is linked to", async () => {
    const lea = await bot("lea");
    const kit = await bot("kit");
    await person("google-p", lea);
    const made = await call(makeRoute, {
      key: lea.key,
      body: { private: true },
    });
    const g = made.body.channel as string;
    const inv = await call(invitesRoute, {
      key: lea.key,
      params: { id: String(num(g)) },
      body: { for: "kit" },
    });
    await call(redeemRoute, {
      key: kit.key,
      body: { code: inv.body.invite.code },
    });
    await send(lea, g, "hello");
    expect((await read(kit, g)).status).toBe(200);
    expect(await row(g, kit)).toBeUndefined();
  });
});

describe("what the person sees of it", () => {
  it("says a bot read their newest message, and when each of their bots last read the group", async () => {
    const { lea, ben, human, channel } = await own();
    await send(lea, channel, "status: started");
    const mine = await personSays(human, channel, "how is it going");
    let page = await readGroupForPerson(db(), human, num(channel), {});
    expect(page?.seen?.message_id).toBe(mine);
    expect(page?.seen?.bots.find((b) => b.handle === "ben")?.kind).not.toBe(
      "read",
    );
    expect(page?.last_word.find((b) => b.handle === "ben")?.read_at).toBeNull();
    await read(ben, channel);
    page = await readGroupForPerson(db(), human, num(channel), {});
    const seen = page?.seen?.bots.find((b) => b.handle === "ben");
    expect(seen?.kind).toBe("read");
    expect(seen?.at).toEqual((await row(channel, ben))?.at);
    expect(page?.last_word.find((b) => b.handle === "ben")).toMatchObject({
      at: null,
      read_at: (await row(channel, ben))?.at,
    });
    expect((await row(channel, ben))?.person).toBe(mine);
    // A read from before the person's message isn't a read of it.
    const later = await personSays(human, channel, "and now");
    page = await readGroupForPerson(db(), human, num(channel), {});
    expect(page?.seen?.message_id).toBe(later);
    expect(page?.seen?.bots.find((b) => b.handle === "ben")?.kind).not.toBe(
      "read",
    );
  });

  it("says a bot read the person's message only if a read gave it that message", async () => {
    const { lea, ben, human, channel } = await own();
    const mine = await personSays(human, channel, "please look");
    const after = await send(lea, channel, "on it");
    // A read that starts past the person's message reads further, but
    // wasn't given it.
    expect((await read(ben, channel, `?after=${mine}`)).status).toBe(200);
    expect((await row(channel, ben))?.upto).toBe(after);
    expect((await row(channel, ben))?.person).toBe(0);
    let page = await readGroupForPerson(db(), human, num(channel), {});
    expect(page?.seen?.message_id).toBe(mine);
    expect(page?.seen?.bots.find((b) => b.handle === "ben")?.kind).not.toBe(
      "read",
    );
    // It still looked in.
    expect(
      page?.last_word.find((b) => b.handle === "ben")?.read_at,
    ).not.toBeNull();
    // Paging back to it gives it the message: now it read it, and the time
    // is when it was given, which a later read doesn't move.
    expect((await read(ben, channel, `?before=${after}`)).status).toBe(200);
    const given = await row(channel, ben);
    expect(given?.person).toBe(mine);
    page = await readGroupForPerson(db(), human, num(channel), {});
    const seen = page?.seen?.bots.find((b) => b.handle === "ben");
    expect(seen?.kind).toBe("read");
    expect(seen?.at).toEqual(given?.person_at);
    await db().begin(async (tx) => {
      await tx`ALTER TABLE channel_reads DISABLE TRIGGER channel_reads_only_up`;
      await tx`UPDATE channel_reads SET read_at = now() - interval '2 minutes'
        WHERE bot_id = ${ben.id}`;
      await tx`ALTER TABLE channel_reads ENABLE TRIGGER channel_reads_only_up`;
    });
    await read(ben, channel);
    expect((await row(channel, ben))?.person_at).toEqual(given?.person_at);
  });

  it("shows nothing of another person's bot's reads, and nothing from before a bot was linked", async () => {
    const lea = await bot("lea");
    const otto = await bot("otto");
    const p = await person("google-p", lea);
    await person("google-q", otto);
    const made = await call(makeRoute, {
      key: lea.key,
      body: { private: true },
    });
    const g = made.body.channel as string;
    const inv = await call(invitesRoute, {
      key: lea.key,
      params: { id: String(num(g)) },
      body: { for: "otto" },
    });
    await call(redeemRoute, {
      key: otto.key,
      body: { code: inv.body.invite.code },
    });
    await send(lea, g, "hello");
    await read(otto, g);
    await read(lea, g);
    expect((await row(g, otto))?.upto).toBeGreaterThan(0);
    const page = await readGroupForPerson(db(), p, num(g), {});
    expect(page?.last_word.map((b) => b.handle)).toEqual(["lea"]);
    expect(page?.last_word[0]?.read_at).toEqual((await row(g, lea))?.at);
    // A read from before the bot was linked to the reader isn't theirs to see.
    await db().begin(async (tx) => {
      await tx`ALTER TABLE channel_reads DISABLE TRIGGER channel_reads_only_up`;
      await tx`UPDATE channel_reads cr SET read_at = b.linked_at - interval '1 hour'
        FROM bots b WHERE b.id = cr.bot_id AND b.handle = 'lea'`;
      await tx`ALTER TABLE channel_reads ENABLE TRIGGER channel_reads_only_up`;
    });
    const again = await readGroupForPerson(db(), p, num(g), {});
    expect(again?.last_word[0]?.read_at).toBeNull();
  });
});
