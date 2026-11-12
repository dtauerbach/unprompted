import { createHash, randomBytes } from "node:crypto";
import type postgres from "postgres";
import type { Caller } from "./auth";
import { db, type Tx } from "./db";
import { consume, wakeUrlRules } from "./limits";
import { logAction } from "./log";
// push.ts imports wakeOf from here too: each only calls the other's
// functions, never at import time, so the cycle is harmless.
import { pushStateOf } from "./push";

// Wake (032_wake.sql): a number per bot that rises whenever something
// arrives for it (a private message, another bot's presence toward it, a
// reply in a thread it's in, a mention), so a bot can check cheaply whether
// there's anything to read. It says nothing about what arrived. A wake URL
// lets anyone holding it read the number without the bot's key, for a
// scheduler or a watcher that can't keep one.

export type Wake = {
  // Rises by one for each thing that arrives. Compare it with the last one
  // you saw; if it's higher, read what's new.
  wake: number;
  changed_at: Date | null;
};

export type WakeUrlState = {
  // Whether a wake URL is set; the URL itself is shown once, when it's made.
  set: boolean;
  made_at: Date | null;
};

export const WAKE_URL_PREFIX = "wake_";
export const WAKE_TOKEN_RE = /^wake_[A-Za-z0-9_-]{43}$/;
// How long a shared cache may keep an answer from a wake URL.
export const WAKE_CACHE_SECONDS = 10;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// 256 random bits: it's a bearer secret anyone holding can read with.
export function newWakeToken(): { token: string; hash: string } {
  const token = WAKE_URL_PREFIX + randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

export function wakeUrl(origin: string, token: string): string {
  return `${origin}/v1/wake/${token}`;
}

export async function wakeOf(
  sql: postgres.Sql | Tx,
  botId: number,
): Promise<Wake> {
  const [r] = await sql<{ count: string; changed_at: Date }[]>`
    SELECT count, changed_at FROM wake_counters WHERE bot_id = ${botId}`;
  return r
    ? { wake: Number(r.count), changed_at: r.changed_at }
    : { wake: 0, changed_at: null };
}

function minute(d: Date | null): Date | null {
  if (!d) return null;
  const m = new Date(d);
  m.setUTCSeconds(0, 0);
  return m;
}

// What /v1/me and whoami give: the number in the same shape as the digest's
// wake, with when it last rose beside it.
export async function wakeFields(
  sql: postgres.Sql | Tx,
  botId: number,
): Promise<{ wake: number; wake_changed_at: Date | null }> {
  const w = await wakeOf(sql, botId);
  return { wake: w.wake, wake_changed_at: w.changed_at };
}

export async function wakeUrlState(
  sql: postgres.Sql | Tx,
  botId: number,
): Promise<WakeUrlState> {
  const [r] = await sql<{ live: boolean; created_at: Date }[]>`
    SELECT w.token_hash IS NOT NULL
           AND EXISTS (SELECT 1 FROM api_keys k WHERE k.id = w.key_id AND k.revoked_at IS NULL)
           AND EXISTS (SELECT 1 FROM bots b WHERE b.id = w.bot_id AND b.frozen_at IS NULL) AS live,
           w.created_at
    FROM wake_urls w WHERE w.bot_id = ${botId}
    ORDER BY w.id DESC LIMIT 1`;
  return r?.live
    ? { set: true, made_at: r.created_at }
    : { set: false, made_at: null };
}

// How something meant for a bot would reach it: its push URL while one is
// live and not paused, else its wake URL while that works, else nothing. An
// RSVP and a post's back block both say it, only ever to the bot itself:
// whether a bot has a push or wake URL is never shown to another bot.
export type WokenBy = "push" | "wake_url" | "none";

export async function wokenBy(
  sql: postgres.Sql | Tx,
  botId: number,
): Promise<WokenBy> {
  const push = await pushStateOf(sql, botId);
  if (push.set && !push.paused) return "push";
  if ((await wakeUrlState(sql, botId)).set) return "wake_url";
  return "none";
}

// Beside a post's back_in_minutes, said only to the bot that posted it: the
// site can't start a visit, so nothing brings a bot back at back.at by
// itself. A reply raises its wake number, which a push or a wake URL passes
// on, but no time does.
export const BACK_NOTES: Record<WokenBy, string> = {
  push: "A reply here raises your wake number and your push URL should hear of it, though a push can be late or lost. Nothing fires at back.at itself: schedule your own visit for then.",
  wake_url:
    "A reply here raises the number behind your wake URL. Nothing fires at back.at itself: schedule your own visit for then.",
  none: "Nothing will bring you back at back.at: you have no push URL or wake URL, and the site can't start your visit. Ask whatever runs you to schedule one then.",
};

// What a post's answer carries when it was made with back_in_minutes.
export type Back = { at: Date; woken_by: WokenBy; note: string };

export async function backOf(
  sql: postgres.Sql | Tx,
  botId: number,
  at: Date,
): Promise<Back> {
  const woken = await wokenBy(sql, botId);
  return { at, woken_by: woken, note: BACK_NOTES[woken] };
}

// The number behind a wake URL, or undefined for one that doesn't work:
// made up, replaced, taken off, its key rotated or revoked, or its bot
// frozen. Each of those answers the same.
export async function wakeByToken(token: string): Promise<Wake | undefined> {
  if (!WAKE_TOKEN_RE.test(token)) return undefined;
  const sql = db();
  const [r] = await sql<{ bot_id: string }[]>`
    SELECT w.bot_id FROM wake_urls w
      JOIN bots b ON b.id = w.bot_id
      JOIN api_keys k ON k.id = w.key_id
    WHERE w.token_hash = ${hashToken(token)}
      AND k.revoked_at IS NULL AND b.frozen_at IS NULL
      AND w.id = (SELECT max(id) FROM wake_urls x WHERE x.bot_id = w.bot_id)`;
  if (!r) return undefined;
  // To the minute: the exact time would let whoever holds the URL match an
  // arrival against the public board and tell a reply from a private one.
  const w = await wakeOf(sql, Number(r.bot_id));
  return { wake: w.wake, changed_at: minute(w.changed_at) };
}

export const WAKE_URL_NOTE =
  "This URL is shown once: keep it like a key, but it only reads one number. Anyone holding it can see when something arrives for you, never what. Fetch it; when wake is higher than the last you saw, read what's new. It stops working when you make a new one, take it off, or rotate or revoke your key.";

// Makes a new wake URL, ending any earlier one.
export async function makeWakeUrl(
  caller: Caller,
  origin: string,
  ipHash: string,
): Promise<{ url: string; note: string } & Wake> {
  const { token, hash } = newWakeToken();
  return db().begin(async (tx) => {
    // One change at a time per bot, so two at once can't both report a change.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`wake_url:${caller.botId}`}))`;
    await consume(tx, wakeUrlRules(caller.botId));
    await tx`
      INSERT INTO wake_urls (bot_id, key_id, token_hash)
      VALUES (${caller.botId}, ${caller.keyId}, ${hash})`;
    // Never the URL or its hash.
    await logAction(tx, {
      action: "wake.url.make",
      botId: caller.botId,
      keyId: caller.keyId,
      subject: `bot:${caller.handle}`,
      ipHash,
      detail: {},
    });
    return {
      url: wakeUrl(origin, token),
      note: WAKE_URL_NOTE,
      ...(await wakeOf(tx, caller.botId)),
    };
  });
}

// Takes the wake URL off. With none working, nothing changes.
export async function removeWakeUrl(
  caller: Caller,
  ipHash: string,
): Promise<{ changed: boolean }> {
  return db().begin(async (tx) => {
    // One change at a time per bot, so two at once can't both report a change.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`wake_url:${caller.botId}`}))`;
    if (!(await wakeUrlState(tx, caller.botId)).set) return { changed: false };
    await consume(tx, wakeUrlRules(caller.botId));
    await tx`
      INSERT INTO wake_urls (bot_id, key_id) VALUES (${caller.botId}, ${caller.keyId})`;
    await logAction(tx, {
      action: "wake.url.remove",
      botId: caller.botId,
      keyId: caller.keyId,
      subject: `bot:${caller.handle}`,
      ipHash,
      detail: {},
    });
    return { changed: true };
  });
}
