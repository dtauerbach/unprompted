import { generateKeyPairSync, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as makeRoute } from "@/app/v1/channels/route";
import { POST as inboxRoute } from "@/app/v1/me/inbox/route";
import { POST as sendRoute } from "@/app/v1/messages/route";
import { setFrozen, setPrivateChannelHidden } from "@/lib/admin";
import { addAdmin } from "@/lib/admins";
import { builtInCopy, saveCopy } from "@/lib/copy";
import { db } from "@/lib/db";
import { checkDue, forgetDueMinute } from "@/lib/due-check";
import { LIMITS } from "@/lib/limits";
import { postAsPerson } from "@/lib/person-messages";
import {
  checkEndpoint,
  drainPersonPushes,
  NOTICE_BODY_MAX,
  NOTICE_TITLE_MAX,
  nextPersonDue,
  PERSON_PUSH_DEVICES,
  PERSON_PUSH_GAP_SECONDS,
  personPushAllowed,
  personPushAvailable,
  personPushDevices,
  personPushIsOn,
  subscribePerson,
  unsubscribePerson,
  usePersonDeliver,
  vapidConfig,
} from "@/lib/person-push";
import { startChannel } from "@/lib/private-channels";
import type { Delivery } from "@/lib/push";
import { wakeSecretsAvailable } from "@/lib/wake-secrets";
import type { Vapid } from "@/lib/web-push";
import { browser, browserDecrypt } from "./browser-push";
import { ageLink, call, register, resetDb } from "./helpers";

// Push to a person (W1b, 093_person_push.sql, src/lib/person-push.ts): a
// person turns push on for a browser, and a bot writing in a group they
// started sends that browser a notice in the copy store's words that opens
// the channel, never a word the bot wrote.

const jwk = generateKeyPairSync("ec", {
  namedCurve: "P-256",
}).privateKey.export({ format: "jwk" }) as { d: string; x: string; y: string };
const VAPID: Vapid = {
  publicKey: Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x, "base64url"),
    Buffer.from(jwk.y, "base64url"),
  ]).toString("base64url"),
  privateKey: jwk.d,
  subject: "https://unprompted.test",
};

type Bot = { handle: string; key: string; id: number };
type Sent = { url: string; body: Buffer; headers: Record<string, string> };

let sent: Sent[] = [];
let answer: (s: Sent) => Delivery = () => ({ status: 201 });
const deliver = async (
  url: string,
  body: Buffer,
  headers: Record<string, string>,
): Promise<Delivery> => {
  const s = { url, body, headers };
  sent.push(s);
  return answer(s);
};
const drain = () => drainPersonPushes(db(), { deliver, vapid: VAPID });

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

// P's two bots in a group P started.
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
  return {
    lea,
    ben,
    human,
    channel,
    id: Number(channel.replace("private:", "")),
  };
}

const say = (b: Bot, channel: string, body: string) =>
  call(sendRoute, { key: b.key, body: { channel, body } });

let devices = 0;
function device(host = "fcm.googleapis.com") {
  const ua = browser();
  devices++;
  return {
    ua,
    sub: {
      endpoint: `https://${host}/fcm/send/device-${devices}-${"x".repeat(40)}`,
      keys: ua.keys,
    },
  };
}

async function pending(human: number): Promise<number> {
  const [r] = await db()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM person_push_state
     WHERE human_id = ${human} AND pending_since IS NOT NULL`;
  return r?.n ?? 0;
}

beforeEach(async () => {
  await resetDb();
  forgetDueMinute();
  sent = [];
  answer = () => ({ status: 201 });
  process.env.WEB_PUSH_PUBLIC_KEY = VAPID.publicKey;
  process.env.WEB_PUSH_PRIVATE_KEY = VAPID.privateKey;
  process.env.WEB_PUSH_SUBJECT = VAPID.subject;
});
afterEach(() => {
  usePersonDeliver(null);
  delete process.env.UNPROMPTED_READ_ONLY;
  delete process.env.WEB_PUSH_PUBLIC_KEY;
  delete process.env.WEB_PUSH_PRIVATE_KEY;
  delete process.env.WEB_PUSH_SUBJECT;
});

describe("which addresses push can go to", () => {
  it("takes the browsers' push services and nothing else", () => {
    for (const ok of [
      "https://fcm.googleapis.com/fcm/send/abc",
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://web.push.apple.com/QH4s",
      "https://wns2-par02p.notify.windows.com/w/?token=abc",
    ])
      expect(checkEndpoint(ok), ok).not.toBeNull();
    for (const bad of [
      "http://fcm.googleapis.com/fcm/send/abc",
      "https://fcm.googleapis.com:8443/fcm/send/abc",
      "https://user@fcm.googleapis.com/fcm/send/abc",
      "https://evil.example/fcm/send/abc",
      "https://fcm.googleapis.com.evil.example/x",
      "https://127.0.0.1/x",
      "https://a.b.notify.windows.com/x",
      `https://fcm.googleapis.com/${"x".repeat(1000)}`,
      "not a url",
    ])
      expect(checkEndpoint(bad), bad).toBeNull();
  });

  it("needs all three keys of the site's own, which must sign", () => {
    expect(vapidConfig()).not.toBeNull();
    expect(vapidConfig({ ...process.env, WEB_PUSH_SUBJECT: "" })).toBeNull();
    expect(
      vapidConfig({ ...process.env, WEB_PUSH_SUBJECT: "someone" }),
    ).toBeNull();
    expect(
      vapidConfig({ ...process.env, WEB_PUSH_PRIVATE_KEY: "nope" }),
    ).toBeNull();
    const other = generateKeyPairSync("ec", {
      namedCurve: "P-256",
    }).privateKey.export({ format: "jwk" }) as { d: string };
    expect(
      vapidConfig({ ...process.env, WEB_PUSH_PRIVATE_KEY: other.d }),
    ).toBeNull();
    expect(
      vapidConfig({
        ...process.env,
        WEB_PUSH_PUBLIC_KEY: Buffer.alloc(65, 1).toString("base64url"),
      }),
    ).toBeNull();
  });
});

describe("turning push on and off", () => {
  it("keeps the address sealed and only its host in the clear", async () => {
    const { sub } = device();
    expect(await subscribePerson(db(), "google-p", sub, null)).toEqual({
      devices: 1,
    });
    const rows = await db()<{ host: string; device: string }[]>`
      SELECT host, device FROM person_push_subs`;
    expect(rows).toEqual([
      {
        host: "fcm.googleapis.com",
        device: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);
    const [secret] = await db()<{ sealed: Buffer }[]>`
      SELECT sealed FROM person_push_secrets`;
    expect(secret?.sealed.toString("latin1")).not.toContain("device-");
    const log = await db()<{ detail: unknown }[]>`
      SELECT detail FROM action_log WHERE action = 'human.push.subscribe'`;
    expect(JSON.stringify(log)).not.toContain("device-");
    expect(log).toEqual([{ detail: { host: "fcm.googleapis.com" } }]);
  });

  it("saving the same browser again replaces it, and keeps one secret", async () => {
    const { sub } = device();
    await subscribePerson(db(), "google-p", sub, null);
    const again = { ...sub, keys: browser().keys };
    expect(await subscribePerson(db(), "google-p", again, null)).toEqual({
      devices: 1,
    });
    const [n] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM person_push_secrets`;
    expect(n?.n).toBe(1);
  });

  it("refuses an address that isn't a push service's, or keys that aren't keys", async () => {
    const { sub } = device("evil.example");
    await expect(
      subscribePerson(db(), "google-p", sub, null),
    ).rejects.toMatchObject({ code: "invalid_subscription" });
    const good = device().sub;
    await expect(
      subscribePerson(
        db(),
        "google-p",
        { ...good, keys: { p256dh: "AAAA", auth: good.keys.auth } },
        null,
      ),
    ).rejects.toMatchObject({ code: "invalid_subscription" });
    await expect(
      subscribePerson(
        db(),
        "google-p",
        { endpoint: good.endpoint } as never,
        null,
      ),
    ).rejects.toMatchObject({ code: "invalid_subscription" });
    // Keys in their exact shape only: unpadded base64url of a P-256 point
    // and a 16-byte secret (Fable's review of W1).
    for (const keys of [
      { p256dh: `${good.keys.p256dh}=`, auth: good.keys.auth },
      { p256dh: good.keys.p256dh.slice(1), auth: good.keys.auth },
      { p256dh: good.keys.p256dh.replace(/^./, "+"), auth: good.keys.auth },
      { p256dh: good.keys.p256dh, auth: `${good.keys.auth}AA` },
      { p256dh: good.keys.p256dh, auth: good.keys.auth.replace(/^./, "/") },
    ])
      await expect(
        subscribePerson(db(), "google-p", { ...good, keys }, null),
      ).rejects.toMatchObject({ code: "invalid_subscription" });
    const [n] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM person_push_subs`;
    expect(n?.n).toBe(0);
  });

  it("is off without the site's keys, and under the kill switch", async () => {
    delete process.env.WEB_PUSH_PRIVATE_KEY;
    await expect(
      subscribePerson(db(), "google-p", device().sub, null),
    ).rejects.toMatchObject({ status: 503, code: "unavailable" });
    process.env.WEB_PUSH_PRIVATE_KEY = VAPID.privateKey;
    process.env.UNPROMPTED_READ_ONLY = "1";
    await expect(
      subscribePerson(db(), "google-p", device().sub, null),
    ).rejects.toMatchObject({ status: 503, code: "read_only" });
  });

  it(`takes ${PERSON_PUSH_DEVICES} browsers at once`, async () => {
    const subs = Array.from(
      { length: PERSON_PUSH_DEVICES },
      () => device().sub,
    );
    for (const s of subs) await subscribePerson(db(), "google-p", s, null);
    await expect(
      subscribePerson(db(), "google-p", device().sub, null),
    ).rejects.toMatchObject({ status: 409, code: "too_many_devices" });
    // One already on can still be saved again.
    await subscribePerson(db(), "google-p", subs[0] as never, null);
    await unsubscribePerson(db(), "google-p", subs[1]?.endpoint ?? "", null);
    await subscribePerson(db(), "google-p", device().sub, null);
  });

  it("counts turning on against an hourly limit, and a refusal writes nothing", async () => {
    const { sub } = device();
    for (let i = 0; i < LIMITS.personPushPerHour.limit; i++)
      await subscribePerson(db(), "google-p", sub, null);
    await expect(
      subscribePerson(db(), "google-p", sub, null),
    ).rejects.toMatchObject({ status: 429 });
    const [n] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM person_push_subs`;
    expect(n?.n).toBe(LIMITS.personPushPerHour.limit);
  });

  it("turning off always works, isn't counted, and deletes the address", async () => {
    const { sub } = device();
    await subscribePerson(db(), "google-p", sub, null);
    process.env.UNPROMPTED_READ_ONLY = "1";
    expect(
      await unsubscribePerson(db(), "google-p", sub.endpoint, null),
    ).toEqual({ devices: 0 });
    expect(
      await unsubscribePerson(db(), "google-p", sub.endpoint, null),
    ).toEqual({ devices: 0 });
    const [secrets] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM person_push_secrets`;
    expect(secrets?.n).toBe(0);
    const log = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM action_log WHERE action = 'human.push.unsubscribe'`;
    expect(log[0]?.n).toBe(1);
    const [quota] = await db()<{ n: number }[]>`
      SELECT coalesce(sum(count), 0)::int AS n FROM rate_limits
       WHERE bucket LIKE 'person-push:%'`;
    expect(quota?.n).toBe(1);
  });

  it("one person's browser is never another's to turn off", async () => {
    const { sub } = device();
    await subscribePerson(db(), "google-p", sub, null);
    expect(
      await unsubscribePerson(db(), "google-q", sub.endpoint, null),
    ).toEqual({ devices: 0 });
    const [h] = await db()<{ id: string }[]>`
      SELECT id FROM humans WHERE auth_user_id = 'google-p'`;
    expect(await personPushDevices(db(), Number(h?.id))).toBe(1);
  });
});

describe("a notice when a bot writes", () => {
  it("goes to each browser, encrypted, in the site's words, opening the channel", async () => {
    const { lea, human, channel, id } = await own();
    const a = device();
    const b = device("updates.push.services.mozilla.com");
    await subscribePerson(db(), "google-p", a.sub, null);
    await subscribePerson(db(), "google-p", b.sub, null);
    expect((await say(lea, channel, "the secret plan is X")).status).toBe(201);
    expect(await pending(human)).toBe(1);
    expect(await drain()).toEqual({ sent: 2, dropped: 0, failed: 0 });
    expect(sent.map((s) => s.url).sort()).toEqual(
      [a.sub.endpoint, b.sub.endpoint].sort(),
    );
    const copy = builtInCopy();
    for (const s of sent) {
      const ua = s.url === a.sub.endpoint ? a.ua : b.ua;
      const plain = browserDecrypt(s.body, ua.priv, ua.auth).toString("utf8");
      expect(JSON.parse(plain)).toEqual({
        title: copy["account.push.notice_title"],
        body: copy["account.push.notice_body"],
        url: `/account/channels/${id}`,
      });
      expect(plain).not.toContain("secret plan");
      expect(s.body.toString("latin1")).not.toContain("secret plan");
      expect(s.headers["content-encoding"]).toBe("aes128gcm");
      expect(s.headers.ttl).toBe("86400");
      expect(s.headers.authorization).toMatch(
        new RegExp(`^vapid t=[^,]+, k=${VAPID.publicKey}$`),
      );
    }
    expect(await pending(human)).toBe(0);
    const log = await db()<{ detail: unknown }[]>`
      SELECT detail FROM action_log WHERE action = 'person_push.sent' ORDER BY id`;
    expect(log).toHaveLength(2);
    expect(JSON.stringify(log)).not.toMatch(/device-|secret plan/);
  });

  it("makes one notice of a burst, and another once the gap is over", async () => {
    const { lea, ben, human, channel } = await own();
    await subscribePerson(db(), "google-p", device().sub, null);
    await say(lea, channel, "one");
    await drain();
    await say(ben, channel, "two");
    await say(lea, channel, "three");
    expect(await drain()).toEqual({ sent: 0, dropped: 1, failed: 0 });
    expect(sent).toHaveLength(1);
    await db()`UPDATE person_push_state
                  SET last_sent_at = now() - make_interval(secs => ${PERSON_PUSH_GAP_SECONDS + 1})
                WHERE human_id = ${human}`;
    await say(ben, channel, "four");
    expect(await drain()).toEqual({ sent: 1, dropped: 0, failed: 0 });
  });

  it("doesn't come for the person's own message, or without push on", async () => {
    const { lea, human, channel } = await own();
    await say(lea, channel, "before push");
    expect(await pending(human)).toBe(0);
    await subscribePerson(db(), "google-p", device().sub, null);
    const prev = process.env.UNPROMPTED_PERSON_POSTS;
    process.env.UNPROMPTED_PERSON_POSTS = "1";
    try {
      await postAsPerson(db(), {
        authUserId: "google-p",
        channel,
        body: "from me",
        wake: false,
        nonce: "nonce-000000000001",
        ipHash: null,
      });
    } finally {
      if (prev === undefined) delete process.env.UNPROMPTED_PERSON_POSTS;
      else process.env.UNPROMPTED_PERSON_POSTS = prev;
    }
    expect(await pending(human)).toBe(0);
  });

  it("doesn't come for a pair's messages or a group a bot made", async () => {
    const { lea, ben, human } = await own();
    await subscribePerson(db(), "google-p", device().sub, null);
    for (const b of [lea, ben])
      await call(inboxRoute, { key: b.key, body: { open: true } });
    const pair = await call(sendRoute, {
      key: lea.key,
      body: { to: ben.handle, body: "hi" },
    });
    expect(pair.status, JSON.stringify(pair.body)).toBe(201);
    const made = await call(makeRoute, {
      key: lea.key,
      body: { private: true },
    });
    expect(made.status).toBe(201);
    expect((await say(lea, made.body.channel, "alone")).status).toBe(201);
    expect(await pending(human)).toBe(0);
  });

  it("sends nothing for a hidden group, or once none of the person's bots is in it", async () => {
    const { lea, ben, human, channel, id } = await own();
    await subscribePerson(db(), "google-p", device().sub, null);
    await say(lea, channel, "one");
    await setPrivateChannelHidden(db(), id, true, "test");
    expect(await drain()).toEqual({ sent: 0, dropped: 1, failed: 0 });
    await setPrivateChannelHidden(db(), id, false, "test");
    await setFrozen(db(), lea.handle, true, "test");
    await setFrozen(db(), ben.handle, true, "test");
    await db()`UPDATE person_push_state SET pending_since = now() WHERE human_id = ${human}`;
    expect(await drain()).toEqual({ sent: 0, dropped: 1, failed: 0 });
    expect(sent).toHaveLength(0);
  });

  it("ends a browser the push service says is gone, and keeps one that only failed", async () => {
    const { lea, human, channel } = await own();
    const gone = device();
    const flaky = device();
    await subscribePerson(db(), "google-p", gone.sub, null);
    await subscribePerson(db(), "google-p", flaky.sub, null);
    answer = (s) => ({ status: s.url === gone.sub.endpoint ? 410 : 500 });
    await say(lea, channel, "one");
    expect(await drain()).toEqual({ sent: 0, dropped: 0, failed: 2 });
    expect(await personPushDevices(db(), human)).toBe(1);
    const ends = await db()<{ ended: string }[]>`
      SELECT ended FROM person_push_subs WHERE ended IS NOT NULL`;
    expect(ends).toEqual([{ ended: "gone" }]);
    const [secrets] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM person_push_secrets`;
    expect(secrets?.n).toBe(1);
  });

  it("sends nothing without the site's keys or under the kill switch", async () => {
    const { lea, human, channel } = await own();
    await subscribePerson(db(), "google-p", device().sub, null);
    await say(lea, channel, "one");
    expect(await drainPersonPushes(db(), { deliver, vapid: null })).toEqual({
      sent: 0,
      dropped: 0,
      failed: 0,
    });
    process.env.UNPROMPTED_READ_ONLY = "1";
    expect(await drain()).toEqual({ sent: 0, dropped: 0, failed: 0 });
    expect(sent).toHaveLength(0);
    expect(await pending(human)).toBe(1);
  });

  it("leaves what it can't reach by its deadline for the next round", async () => {
    const { lea, ben, human, channel } = await own();
    const cy = await bot("cyd");
    await link("google-p", cy);
    const { channel: second } = await startChannel(
      db(),
      "google-p",
      ["ben", "cyd"],
      "ben",
      null,
    );
    await subscribePerson(db(), "google-p", device().sub, null);
    await say(lea, channel, "one");
    await say(ben, second, "two");
    expect(await pending(human)).toBe(2);
    // Past its deadline already: claims nothing, and says what waits, so
    // the round leaves it to the clock (Fable's second review of W1).
    let t = 1_000;
    const late = { deliver, vapid: VAPID, now: () => t, until: 1_000 };
    expect(await drainPersonPushes(db(), late)).toEqual({
      sent: 0,
      dropped: 0,
      failed: 0,
      deferred: 2,
    });
    expect(await pending(human)).toBe(2);
    // The first send runs the clock out: the second channel waits again.
    t = 999;
    const slow = {
      ...late,
      deliver: async (...a: Parameters<typeof deliver>) => {
        t = 2_000;
        return deliver(...a);
      },
    };
    expect(await drainPersonPushes(db(), slow)).toEqual({
      sent: 1,
      dropped: 0,
      failed: 0,
      deferred: 1,
    });
    expect(await pending(human)).toBe(1);
    expect(await drain()).toEqual({ sent: 1, dropped: 0, failed: 0 });
    expect(sent).toHaveLength(2);
  });

  it("sends nothing from a Vercel deploy but production's", async () => {
    // Fable's second review of W1: a preview's database is a branch of
    // production's, its sealed addresses included.
    const { lea, human, channel } = await own();
    await subscribePerson(db(), "google-p", device().sub, null);
    await say(lea, channel, "one");
    process.env.VERCEL = "1";
    try {
      for (const env of ["preview", "development"]) {
        process.env.VERCEL_ENV = env;
        expect(await drain()).toEqual({ sent: 0, dropped: 0, failed: 0 });
        expect(await nextPersonDue(db())).toBeNull();
      }
      expect(sent).toHaveLength(0);
      expect(await pending(human)).toBe(1);
      process.env.VERCEL_ENV = "production";
      expect(await drain()).toEqual({ sent: 1, dropped: 0, failed: 0 });
    } finally {
      delete process.env.VERCEL;
      delete process.env.VERCEL_ENV;
    }
  });

  it("can't be turned on, and sends nothing, from a production build off Vercel", async () => {
    // Fable's review of 42c2ecf: CI's eval server, or a build run by hand
    // against production's database, is fenced like a preview.
    const { lea, human, channel } = await own();
    await subscribePerson(db(), "google-p", device().sub, null);
    await say(lea, channel, "one");
    expect(personPushAvailable()).toBe(true);
    vi.stubEnv("NODE_ENV", "production");
    // A key of its own, so only the fence can make it unavailable.
    vi.stubEnv("WAKE_SECRET_KEY", randomBytes(32).toString("hex"));
    try {
      expect(wakeSecretsAvailable()).toBe(true);
      expect(personPushAllowed()).toBe(false);
      expect(personPushAvailable()).toBe(false);
      await expect(
        subscribePerson(db(), "google-p", device().sub, null),
      ).rejects.toMatchObject({ status: 503 });
      expect(await drain()).toEqual({ sent: 0, dropped: 0, failed: 0 });
      expect(sent).toHaveLength(0);
      expect(await pending(human)).toBe(1);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(personPushAllowed()).toBe(true);
  });

  it("puts back what it claimed when a send throws, so nothing is lost", async () => {
    // Fable's second review of W1: a throw after the claim (a dropped
    // connection, say) left every claimed channel marked sent, so its
    // notice was lost and the next message inside the gap dropped.
    const { lea, ben, human, channel } = await own();
    const cy = await bot("cyd");
    await link("google-p", cy);
    const { channel: second } = await startChannel(
      db(),
      "google-p",
      ["ben", "cyd"],
      "ben",
      null,
    );
    await subscribePerson(db(), "google-p", device().sub, null);
    await say(lea, channel, "one");
    await say(ben, second, "two");
    const throws = async () => {
      throw new Error("connection dropped");
    };
    const quiet = console.error;
    console.error = () => {};
    try {
      expect(
        await drainPersonPushes(db(), { deliver: throws, vapid: VAPID }),
      ).toEqual({ sent: 0, dropped: 0, failed: 2, deferred: 2 });
    } finally {
      console.error = quiet;
    }
    expect(await pending(human)).toBe(2);
    // Nor did the gap start: both go on the next round.
    expect(await drain()).toEqual({ sent: 2, dropped: 0, failed: 0 });
  });

  it("puts every mark back when reading the words throws", async () => {
    const { lea, ben, human, channel } = await own();
    const cy = await bot("cyd");
    await link("google-p", cy);
    const { channel: second } = await startChannel(
      db(),
      "google-p",
      ["ben", "cyd"],
      "ben",
      null,
    );
    await subscribePerson(db(), "google-p", device().sub, null);
    await say(lea, channel, "one");
    await say(ben, second, "two");
    const quiet = console.error;
    console.error = () => {};
    try {
      expect(
        await drainPersonPushes(db(), {
          deliver,
          vapid: VAPID,
          copy: async () => {
            throw new Error("copy store unreachable");
          },
        }),
      ).toEqual({ sent: 0, dropped: 0, failed: 0, deferred: 2 });
    } finally {
      console.error = quiet;
    }
    expect(sent).toHaveLength(0);
    expect(await pending(human)).toBe(2);
    expect(await drain()).toEqual({ sent: 2, dropped: 0, failed: 0 });
  });

  it("keeps the gap when one browser took the notice before a throw", async () => {
    const { lea, ben, human, channel } = await own();
    const a = device();
    const b = device("updates.push.services.mozilla.com");
    await subscribePerson(db(), "google-p", a.sub, null);
    await subscribePerson(db(), "google-p", b.sub, null);
    await say(lea, channel, "one");
    let n = 0;
    const second = async (...args: Parameters<typeof deliver>) => {
      n++;
      if (n > 1) throw new Error("connection dropped");
      return deliver(...args);
    };
    const quiet = console.error;
    console.error = () => {};
    try {
      expect(
        await drainPersonPushes(db(), { deliver: second, vapid: VAPID }),
      ).toEqual({ sent: 1, dropped: 0, failed: 1 });
    } finally {
      console.error = quiet;
    }
    // Not waiting again: the person has a notice that opens the channel,
    // so the next message inside the gap is dropped.
    expect(await pending(human)).toBe(0);
    await say(ben, channel, "two");
    expect(await drain()).toEqual({ sent: 0, dropped: 1, failed: 0 });
  });

  it("cuts long words from the copy store to what a browser shows", async () => {
    // Fable's second review of W1: words past a push's size made every
    // notice throw.
    const { lea, channel } = await own();
    const a = device();
    await subscribePerson(db(), "google-p", a.sub, null);
    const { humanId } = await addAdmin(
      db(),
      { authUserId: "google-admin" },
      "Setup.",
      "x",
    );
    for (const key of [
      "account.push.notice_title",
      "account.push.notice_body",
    ] as const)
      await saveCopy(db(), {
        key,
        body: "w".repeat(2000),
        after: 0,
        editor: { humanId, role: "admin", keyId: null },
        ipHash: null,
      });
    await say(lea, channel, "one");
    expect(await drain()).toEqual({ sent: 1, dropped: 0, failed: 0 });
    const plain = JSON.parse(
      browserDecrypt(
        sent[0]?.body ?? Buffer.alloc(0),
        a.ua.priv,
        a.ua.auth,
      ).toString("utf8"),
    );
    expect(plain.title).toBe("w".repeat(NOTICE_TITLE_MAX));
    expect(plain.body).toBe("w".repeat(NOTICE_BODY_MAX));
  });

  it("never starts the gap on a send that reached no browser", async () => {
    // Fable's review of W1: a failed send marked the channel sent, so the
    // next message inside the gap was dropped and the person never heard.
    const { lea, ben, channel } = await own();
    await subscribePerson(db(), "google-p", device().sub, null);
    answer = () => ({ status: 500 });
    await say(lea, channel, "one");
    expect(await drain()).toEqual({ sent: 0, dropped: 0, failed: 1 });
    answer = () => ({ status: 201 });
    await say(ben, channel, "two");
    expect(await drain()).toEqual({ sent: 1, dropped: 0, failed: 0 });
    // And a sent one still starts it.
    await say(lea, channel, "three");
    expect(await drain()).toEqual({ sent: 0, dropped: 1, failed: 0 });
  });

  it("is sent by the clock when a round left one waiting", async () => {
    // Fable's review of W1: a notice a round left (cut off by its deadline,
    // or brought by a write during it) waited for the next write.
    const { lea, human, channel } = await own();
    expect(await nextPersonDue(db())).toBeNull();
    await subscribePerson(db(), "google-p", device().sub, null);
    await say(lea, channel, "one");
    const due = await nextPersonDue(db());
    expect(due).not.toBeNull();
    // Nothing a drain would take: no keys, or the kill switch.
    delete process.env.WEB_PUSH_PRIVATE_KEY;
    expect(await nextPersonDue(db())).toBeNull();
    process.env.WEB_PUSH_PRIVATE_KEY = VAPID.privateKey;
    process.env.UNPROMPTED_READ_ONLY = "1";
    expect(await nextPersonDue(db())).toBeNull();
    delete process.env.UNPROMPTED_READ_ONLY;
    usePersonDeliver(deliver);
    expect(await checkDue(Date.now() + 60_000)).toBe("worked");
    expect(sent).toHaveLength(1);
    expect(await pending(human)).toBe(0);
    expect(await nextPersonDue(db())).toBeNull();
  });

  it("goes to one person per browser: turning it on moves it", async () => {
    // Fable's review of W1: in a browser two people share, the first
    // person's notices kept coming after the second turned them on.
    const { lea, human, channel } = await own();
    const shared = device();
    await subscribePerson(db(), "google-p", shared.sub, null);
    expect(await personPushIsOn(db(), "google-p", shared.sub.endpoint)).toBe(
      true,
    );
    expect(await subscribePerson(db(), "google-q", shared.sub, null)).toEqual({
      devices: 1,
    });
    expect(await personPushIsOn(db(), "google-p", shared.sub.endpoint)).toBe(
      false,
    );
    expect(await personPushIsOn(db(), "google-q", shared.sub.endpoint)).toBe(
      true,
    );
    expect(await personPushDevices(db(), human)).toBe(0);
    const ends = await db()<{ ended: string }[]>`
      SELECT ended FROM person_push_subs WHERE ended IS NOT NULL`;
    expect(ends).toEqual([{ ended: "moved" }]);
    await say(lea, channel, "one");
    expect(await pending(human)).toBe(0);
    expect(await drain()).toEqual({ sent: 0, dropped: 0, failed: 0 });
    // Moving it back to P is the same.
    await subscribePerson(db(), "google-p", shared.sub, null);
    expect(await personPushIsOn(db(), "google-q", shared.sub.endpoint)).toBe(
      false,
    );
    await say(lea, channel, "two");
    expect(await drain()).toEqual({ sent: 1, dropped: 0, failed: 0 });
    // Never on for someone who isn't signed in to it, or for a stranger's
    // address.
    expect(await personPushIsOn(db(), "google-z", shared.sub.endpoint)).toBe(
      false,
    );
    expect(await personPushIsOn(db(), "google-p", device().sub.endpoint)).toBe(
      false,
    );
  });

  it("table rows can't be changed or taken back", async () => {
    await subscribePerson(db(), "google-p", device().sub, null);
    await expect(
      db()`UPDATE person_push_subs SET host = 'x'`,
    ).rejects.toThrow();
    await expect(db()`DELETE FROM person_push_subs`).rejects.toThrow();
  });
});
