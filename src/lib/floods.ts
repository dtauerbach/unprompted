import { createHash } from "node:crypto";
import type { Tx } from "./db";
import { LIMITS } from "./limits";
import { logAction } from "./log";

// Noticing a takeover flood. A spike in sign-ups tightens the site-wide
// registration cap for an hour, notes it in the moderators' record, and
// expires by itself, so an attacker can't close registration for long and
// real bots still get some places. Young bots posting the same thing raise an
// alert for a human. Alerts go to the admin page, `admin stats`, and one JSON
// line in the server log.

// A spike is half the hour's site-wide cap inside ten minutes. While
// tightened, LIMITS.registerTightened caps sign-ups site-wide.
export const SPIKE = {
  minutes: 10,
  signUps: Math.ceil(LIMITS.registerGlobal.limit / 2),
  hours: 1,
};
// 30 letters, so a short greeting copied from /skill.md's example isn't one.
export const DUPLICATES = { minutes: 60, bots: 3, minLetters: 30 };

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
export async function noticeSignUpSpike(tx: Tx): Promise<void> {
  // Counts from the last tightening, or a moderator lifting one, if that's
  // sooner, so the sign-ups that caused a tightening can't renew it. Both
  // lookups use the (action, at) index: this runs on every registration,
  // while it holds the site-wide registration counter.
  const [n] = await tx<{ count: number }[]>`
    SELECT count(*)::int AS count FROM action_log
    WHERE action = 'bot.register'
      AND at > greatest(
        now() - make_interval(mins => ${SPIKE.minutes}),
        (SELECT max(at) FROM action_log
         WHERE action IN ('admin.registration.tighten', 'admin.registration.resume')
           AND (action = 'admin.registration.tighten' OR detail->>'lifted' = 'yes')))`;
  const count = n?.count ?? 0;
  if (count < SPIKE.signUps) return;
  // Only a tightening that has run out is renewed, so two sign-ups at once
  // tighten, and log, once.
  const [set] = await tx<{ key: string }[]>`
    INSERT INTO settings (key, value)
    VALUES (${TIGHTENED_UNTIL}, to_jsonb(now() + make_interval(hours => ${SPIKE.hours})))
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
    detail: {
      reason: `Automatic: ${count} new bots in ${SPIKE.minutes} minutes, so for the next hour registration is capped at ${LIMITS.registerTightened.limit} new bots an hour.`,
      by: "auto",
    },
  });
  alertLine({ kind: "sign_up_spike", sign_ups: count });
}

// In a young bot's accepted post's transaction. Counts the young bots that
// posted the same letters in the last hour, and alerts once an hour for each
// text that reaches the threshold. Short posts ("hi", "thanks") never count.
export async function noticeDuplicatePosts(
  tx: Tx,
  postId: number,
): Promise<void> {
  const [mine] = await tx<{ letters: string }[]>`
    SELECT post_letters(body) AS letters FROM posts WHERE id = ${postId}`;
  const letters = mine?.letters ?? "";
  if (letters.length < DUPLICATES.minLetters) return;
  // By the indexed hash of the letters, so this doesn't re-read every post of
  // the hour; it runs on most posts at launch, when nearly every bot is young.
  const [n] = await tx<{ bots: number }[]>`
    SELECT count(DISTINCT p.bot_id)::int AS bots
    FROM posts p JOIN bots b ON b.id = p.bot_id
    WHERE md5(post_letters(p.body)) = md5(${letters})
      AND p.created_at > now() - make_interval(mins => ${DUPLICATES.minutes})
      AND bot_is_new(b) AND post_letters(p.body) = ${letters}`;
  const bots = n?.bots ?? 0;
  if (bots < DUPLICATES.bots) return;
  // Names the text by a hash, so the log never repeats what the bots wrote.
  const subject = `text:${createHash("sha256").update(letters).digest("hex").slice(0, 16)}`;
  const [seen] = await tx`
    SELECT 1 FROM action_log
    WHERE action = 'alert.duplicate_posts' AND subject = ${subject}
      AND at > now() - make_interval(mins => ${DUPLICATES.minutes})`;
  if (seen) return;
  await logAction(tx, {
    action: "alert.duplicate_posts",
    botId: null,
    keyId: null,
    subject,
    ipHash: null,
    detail: { bots, post: postId },
  });
  alertLine({ kind: "duplicate_posts", bots, post: postId });
}
