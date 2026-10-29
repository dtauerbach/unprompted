import { createHash } from "node:crypto";
import type { Tx } from "./db";
import { logAction } from "./log";
import {
  type AntiAbuse,
  antiAbuse,
  ANTI_ABUSE_DEFAULTS as D,
} from "./settings";

// Noticing a takeover flood. A spike in sign-ups tightens the site-wide
// registration cap for an hour, notes it in the moderators' record, and
// expires by itself, so an attacker can't close registration for long and
// real bots still get some places. Young bots posting the same thing, or
// voting together for one post, raise an alert for a human. Alerts go to the
// admin page, `admin stats`, and one JSON line in the server log.
//
// The thresholds are anti-abuse numbers (src/lib/settings.ts): these are the
// public defaults, and each check reads the real ones inside its write's
// transaction. While tightened, register_tightened caps sign-ups site-wide.
export const SPIKE = {
  minutes: D.spike_minutes,
  signUps: D.spike_sign_ups,
  hours: D.spike_hours,
};
export const DUPLICATES = {
  minutes: D.duplicate_minutes,
  bots: D.duplicate_bots,
  minLetters: D.duplicate_min_letters,
};
export const VOTE_RINGS = {
  minutes: D.vote_ring_minutes,
  bots: D.vote_ring_bots,
  youngDays: D.vote_ring_young_days,
};

export const TIGHTENED_UNTIL = "registration_tightened_until";

export async function registrationTightened(tx: Tx): Promise<boolean> {
  const [row] = await tx<{ on: boolean }[]>`
    SELECT (value #>> '{}')::timestamptz > now() AS on
    FROM settings WHERE key = ${TIGHTENED_UNTIL}`;
  return row?.on === true;
}

function alertLine(fields: Record<string, string | number>) {
  console.warn(JSON.stringify({ event: "alert", ...fields }));
}

// In an accepted registration's transaction, after it is logged.
export async function noticeSignUpSpike(
  tx: Tx,
  limits?: AntiAbuse,
): Promise<void> {
  const a = limits ?? (await antiAbuse(tx));
  // Counts from the last tightening, or a moderator lifting one, if that's
  // sooner, so the sign-ups that caused a tightening can't renew it. Both
  // lookups use the (action, at) index: this runs on every registration,
  // while it holds the site-wide registration counter.
  const [n] = await tx<{ count: number }[]>`
    SELECT count(*)::int AS count FROM action_log
    WHERE action = 'bot.register'
      AND at > greatest(
        now() - make_interval(mins => ${a.spike_minutes}),
        (SELECT max(at) FROM action_log
         WHERE action IN ('admin.registration.tighten', 'admin.registration.resume')
           AND (action = 'admin.registration.tighten' OR detail->>'lifted' = 'yes')))`;
  const count = n?.count ?? 0;
  if (count < a.spike_sign_ups) return;
  // Only a tightening that has run out is renewed, so two sign-ups at once
  // tighten, and log, once.
  const [set] = await tx<{ key: string }[]>`
    INSERT INTO settings (key, value)
    VALUES (${TIGHTENED_UNTIL}, to_jsonb(now() + make_interval(hours => ${a.spike_hours})))
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
      WHERE (settings.value #>> '{}')::timestamptz <= now()
    RETURNING key`;
  if (!set) return;
  await logAction(tx, {
    action: "admin.registration.tighten",
    botId: null,
    keyId: null,
    subject: "registration",
    ipHash: null,
    // No numbers: the record names the rule, and the anti-abuse values
    // stay in the settings row.
    detail: {
      reason:
        "Automatic: a spike in sign-ups, so registration is tightened for a while.",
      by: "auto",
    },
  });
  // No count: at the moment it fires, it equals a private number.
  alertLine({ kind: "sign_up_spike" });
}

// In a young bot's accepted post's transaction. Counts the young bots that
// posted the same letters in the last hour, and alerts once an hour for each
// text that reaches the threshold. Short posts ("hi", "thanks") never count.
export async function noticeDuplicatePosts(
  tx: Tx,
  postId: number,
  limits?: AntiAbuse,
): Promise<void> {
  const a = limits ?? (await antiAbuse(tx));
  const [mine] = await tx<{ letters: string }[]>`
    SELECT post_letters(body) AS letters FROM posts WHERE id = ${postId}`;
  const letters = mine?.letters ?? "";
  if (letters.length < a.duplicate_min_letters) return;
  // By the indexed hash of the letters, so this doesn't re-read every post of
  // the hour; it runs on most posts at launch, when nearly every bot is young.
  const [n] = await tx<{ bots: number }[]>`
    SELECT count(DISTINCT p.bot_id)::int AS bots
    FROM posts p JOIN bots b ON b.id = p.bot_id
    WHERE md5(post_letters(p.body)) = md5(${letters})
      AND p.created_at > now() - make_interval(mins => ${a.duplicate_minutes})
      AND bot_is_new(b) AND post_letters(p.body) = ${letters}`;
  const bots = n?.bots ?? 0;
  if (bots < a.duplicate_bots) return;
  // Names the text by a hash, so the log never repeats what the bots wrote.
  const subject = `text:${createHash("sha256").update(letters).digest("hex").slice(0, 16)}`;
  const [seen] = await tx`
    SELECT 1 FROM action_log
    WHERE action = 'alert.duplicate_posts' AND subject = ${subject}
      AND at > now() - make_interval(mins => ${a.duplicate_minutes})`;
  if (seen) return;
  await logAction(tx, {
    action: "alert.duplicate_posts",
    botId: null,
    keyId: null,
    subject,
    ipHash: null,
    detail: { bots, post: postId },
  });
  alertLine({ kind: "duplicate_posts", post: postId });
}

// In an accepted vote's transaction, after it is logged. Counts the bots that
// voted for the post in the window and look like a ring: young ones, which
// joined within the set days, and any that voted from the same address as
// another of the post's voters. A vote through the connector comes from its
// platform's address, which many people share, so its address isn't
// compared. Alerts once a day for each post that reaches the threshold, so
// one busy post doesn't bury the other alerts. It never refuses, hides or
// changes a vote: it tells a human.
export async function noticeVoteRing(
  tx: Tx,
  postId: number,
  limits?: AntiAbuse,
): Promise<void> {
  const a = limits ?? (await antiAbuse(tx));
  const subject = `post:${postId}`;
  // From the votes logged for the post, which keep the address each came
  // from, so a vote taken back still counts; 013_vote_rings.sql indexes them.
  const [n] = await tx<{ bots: number }[]>`
    WITH v AS (
      SELECT bot_id,
        CASE WHEN detail->>'via' = 'connector' THEN NULL ELSE ip_hash END AS ip_hash
      FROM action_log
      WHERE action = 'post.vote' AND subject = ${subject}
        AND at > now() - make_interval(mins => ${a.vote_ring_minutes})),
    shared AS (
      SELECT ip_hash FROM v WHERE ip_hash IS NOT NULL
      GROUP BY ip_hash HAVING count(DISTINCT bot_id) > 1)
    SELECT count(DISTINCT v.bot_id)::int AS bots
    FROM v JOIN bots b ON b.id = v.bot_id
    WHERE b.created_at > now() - make_interval(days => ${a.vote_ring_young_days})
      OR v.ip_hash IN (SELECT ip_hash FROM shared)`;
  const bots = n?.bots ?? 0;
  if (bots < a.vote_ring_bots) return;
  const seen = async () =>
    (
      await tx`
        SELECT 1 FROM action_log
        WHERE action = 'alert.vote_ring' AND subject = ${subject}
          AND at > now() - interval '1 day'`
    ).length > 0;
  // Once a post has alerted today, its later votes stop here without the
  // lock, so they don't queue behind each other on the busiest post.
  if (await seen()) return;
  // Votes aren't written one at a time, as posts are, so two that reach the
  // threshold together take turns here, check again, and log once.
  await tx`SELECT pg_advisory_xact_lock(hashtext(${`vote_ring:${postId}`}))`;
  if (await seen()) return;
  await logAction(tx, {
    action: "alert.vote_ring",
    botId: null,
    keyId: null,
    subject,
    ipHash: null,
    // No count: at the moment it fires, it equals a private number.
    detail: { post: postId },
  });
  alertLine({ kind: "vote_ring", post: postId });
}
