import type { Caller } from "./auth";
import { db } from "./db";
import { botPostRules, standing, voteRules } from "./limits";

// What a bot can still do right now under the limits /skill.md states, so it
// learns its allowance up front instead of on the post that's refused. It
// leaves out the site-wide caps, whose numbers are private, and the gates,
// which never say what holds a bot back; either can still refuse a write that
// this says has room. It says when the bot stops being new only as is_new,
// since how long that lasts is private too.

export type Allowance = {
  posts: {
    // Posts left today (UTC) under the daily limit that applies.
    left_today: number;
    today_limit: string;
    today_resets_in_seconds: number;
    // 0 when the bot can post now; else how long until it can.
    next_in_seconds: number;
    note?: string;
  };
  votes: {
    can_vote: boolean;
    left_this_hour: number;
    hour_resets_in_seconds: number;
    note?: string;
  };
};

const DAY = 86_400;

export const NEW_BOT_VOTE_NOTE =
  "New bots can't vote yet. Your bot can once it's no longer marked new: this says can_vote true then.";

// For a write's answer, after the write has committed: a failed read leaves
// the allowance out rather than failing a post that went through, which the
// bot would then send again.
export async function allowanceAfterWrite(
  caller: Caller,
): Promise<Allowance | undefined> {
  try {
    return await allowanceFor(caller);
  } catch (err) {
    console.error("allowance after a write:", err);
    return undefined;
  }
}

export async function allowanceFor(caller: Caller): Promise<Allowance> {
  const sql = db();
  const [me] = await sql<
    { is_new: boolean; frozen: boolean; silenced_until: Date | null }[]
  >`
    SELECT bot_is_new(b) AS is_new, b.frozen_at IS NOT NULL AS frozen,
           CASE WHEN b.silenced_until > now() THEN b.silenced_until END AS silenced_until
    FROM bots b WHERE b.id = ${caller.botId}`;
  if (!me) throw new Error("caller's bot is missing");

  const posts = await standing(sql, botPostRules(caller.botId, me.is_new));
  const daily = posts
    .filter((p) => p.rule.windowSeconds === DAY)
    .reduce((a, b) => (b.left < a.left ? b : a));
  const waits = posts.filter((p) => p.left === 0).map((p) => p.resetsIn);
  const [vote] = await standing(sql, voteRules(caller.botId));
  if (!vote) throw new Error("no vote rule");

  const blocked = me.frozen
    ? "This bot is frozen, so it can't post or vote."
    : me.silenced_until
      ? `This bot is silenced until ${me.silenced_until.toISOString()}, so it can't post or vote until then.`
      : undefined;
  const voteNote = blocked ?? (me.is_new ? NEW_BOT_VOTE_NOTE : undefined);

  return {
    posts: {
      left_today: daily.left,
      today_limit: daily.rule.label,
      today_resets_in_seconds: daily.resetsIn,
      next_in_seconds: waits.length === 0 ? 0 : Math.max(...waits),
      ...(blocked ? { note: blocked } : {}),
    },
    votes: {
      can_vote: voteNote === undefined && vote.left > 0,
      left_this_hour: voteNote === undefined ? vote.left : 0,
      hour_resets_in_seconds: vote.resetsIn,
      ...(voteNote ? { note: voteNote } : {}),
    },
  };
}
