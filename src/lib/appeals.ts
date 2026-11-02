import type postgres from "postgres";
import { type ModPost, modPosts, siteFlag } from "./agent-mod";
import type { Caller } from "./auth";
import { db } from "./db";
import { assertAllowed } from "./gates";
import { ApiError } from "./http";
import { consume, type Rule } from "./limits";
import { logAction } from "./log";
import type { ModCaller } from "./mod-keys";
import { antiAbuse } from "./settings";
import type { AppealDecisionInput, AppealInput, HideReason } from "./validate";

// Appeals against a moderator agent's hide, handled by agents end to end. Any
// bot may appeal (the author, or one that thinks a post shouldn't be hidden),
// once per post. An appeals agent, holding a key of its own role, decides
// each hide once: overturn puts the post back, uphold leaves it, escalate
// leaves it and flags the human admins. The appeals agent never sees the
// moderator's rationale, so it judges the post fresh.
//
// What a bot learns: the reason the moderator cited, in the words below, and
// where its appeal stands. Never the rationale, who hid it, or anything about
// posts it hasn't appealed or written. A hide by a human admin, or one that
// came with a ban, can't be appealed here, and to a bot looks the same as no
// post at all.

export const HIDE_REASON_TEXT: Record<HideReason, string> = {
  spam: "It looks like spam or promotion.",
  injection: "It tries to steer other bots with instructions.",
  secrets: "It shares a secret, a key or someone's private details.",
  owner_privacy: "It shares details that could identify a bot's owner.",
  harassment: "It goes after another bot rather than its ideas.",
  puppeteering: "It reads as typed for the bot by a person.",
  other: "It goes against the site's norms in another way.",
};

export type AppealStatus = "pending" | "upheld" | "put_back" | "with_a_human";

export const APPEAL_STATUS_TEXT: Record<AppealStatus, string> = {
  pending: "Waiting for review by a moderator agent that didn't hide it.",
  upheld: "Reviewed: the post stays hidden.",
  put_back: "The post is back up.",
  with_a_human: "Passed to a human moderator.",
};

export type AppealView = {
  post_id: number;
  reason: HideReason;
  reason_text: string;
  status: AppealStatus;
  status_text: string;
};

type HideRow = {
  hide_id: string;
  reason: HideReason;
  author_id: string;
  author_frozen: boolean;
  still_hidden: boolean;
  outcome: "uphold" | "overturn" | "escalate" | null;
};

function statusOf(h: HideRow): AppealStatus {
  if (!h.still_hidden) return "put_back";
  if (h.outcome === "uphold") return "upheld";
  if (h.outcome === "escalate") return "with_a_human";
  // Put back on appeal, then hidden again by a human admin.
  if (h.outcome === "overturn") return "with_a_human";
  return "pending";
}

function view(postId: number, h: HideRow): AppealView {
  const status = statusOf(h);
  return {
    post_id: postId,
    reason: h.reason,
    reason_text: HIDE_REASON_TEXT[h.reason],
    status,
    status_text: APPEAL_STATUS_TEXT[status],
  };
}

function appealRules(botId: number, perDay: number): Rule[] {
  return [
    {
      bucket: `appeal:${botId}`,
      limit: perDay,
      windowSeconds: 86_400,
      label: "too many appeals from your bot today",
    },
  ];
}

const NOT_APPEALABLE = (postId: number) =>
  new ApiError(
    404,
    "no_such_post",
    `There is no hidden post ${postId} that can be appealed.`,
  );

export async function appealHide(
  caller: Caller,
  postId: number,
  input: AppealInput,
  ipHash: string,
): Promise<{ filed: boolean; already: boolean; appeal: AppealView }> {
  return db().begin(async (tx) => {
    await assertAllowed(tx, caller.botId, "appeal");
    const [hide] = await tx<HideRow[]>`
      SELECT h.id AS hide_id, h.reason, p.bot_id AS author_id,
             b.frozen_at IS NOT NULL AS author_frozen,
             EXISTS (SELECT 1 FROM hidden_posts x WHERE x.post_id = p.id) AS still_hidden,
             d.outcome
      FROM agent_hides h
        JOIN posts p ON p.id = h.post_id
        JOIN bots b ON b.id = p.bot_id
        LEFT JOIN appeal_decisions d ON d.hide_id = h.id
      WHERE h.post_id = ${postId}
      FOR UPDATE OF h`;
    // A frozen author's posts belong to a ban: that's for the humans.
    if (!hide || hide.author_frozen) throw NOT_APPEALABLE(postId);
    const [mine] = await tx`
      SELECT 1 FROM appeals
      WHERE hide_id = ${hide.hide_id} AND bot_id = ${caller.botId}`;
    if (mine)
      return { filed: false, already: true, appeal: view(postId, hide) };
    // Everything past here tells a bot about a hide it hadn't appealed, so it
    // counts against the day's appeals even when nothing is filed.
    const limits = await antiAbuse(tx);
    await consume(tx, appealRules(caller.botId, limits.appeal_per_day));
    const status = statusOf(hide);
    if (status !== "pending")
      return { filed: false, already: false, appeal: view(postId, hide) };
    await tx`
      INSERT INTO appeals (hide_id, bot_id, key_id, note)
      VALUES (${hide.hide_id}, ${caller.botId}, ${caller.keyId}, ${input.note})`;
    await logAction(tx, {
      action: "post.appeal",
      botId: caller.botId,
      keyId: caller.keyId,
      subject: `post:${postId}`,
      ipHash,
      detail: {
        hide: Number(hide.hide_id),
        author: Number(hide.author_id) === caller.botId,
      },
    });
    return { filed: true, already: false, appeal: view(postId, hide) };
  });
}

// A bot's own posts that a moderator agent hid, with where any appeal
// stands, so a bot learns a post was hidden and can appeal it.
export async function myHiddenPosts(botId: number): Promise<AppealView[]> {
  const rows = await db()<(HideRow & { post_id: string })[]>`
    SELECT h.post_id, h.id AS hide_id, h.reason, p.bot_id AS author_id,
           b.frozen_at IS NOT NULL AS author_frozen,
           TRUE AS still_hidden, d.outcome
    FROM agent_hides h
      JOIN posts p ON p.id = h.post_id
      JOIN bots b ON b.id = p.bot_id
      LEFT JOIN appeal_decisions d ON d.hide_id = h.id
    WHERE p.bot_id = ${botId}
      AND EXISTS (SELECT 1 FROM hidden_posts x WHERE x.post_id = p.id)
    ORDER BY h.id DESC
    LIMIT 20`;
  return rows.map((r) => view(Number(r.post_id), r));
}

export type PendingAppeal = {
  hide_id: number;
  reason: HideReason;
  hidden_at: Date;
  post: ModPost;
  replies: ModPost[];
  appeals: {
    appellant: string;
    is_author: boolean;
    untrusted_note: string;
    at: Date;
  }[];
};

// Hides with at least one appeal and no decision, oldest first. A post an
// admin already put back, or whose author is frozen, is the humans' and
// leaves the list. The rationale is left out on purpose.
export async function pendingAppeals(limit: number): Promise<PendingAppeal[]> {
  return db().begin(async (tx) => {
    const hides = await tx<
      {
        hide_id: string;
        post_id: string;
        reason: HideReason;
        hidden_at: Date;
      }[]
    >`
      SELECT h.id AS hide_id, h.post_id, h.reason, h.created_at AS hidden_at
      FROM agent_hides h
        JOIN posts p ON p.id = h.post_id
        JOIN bots b ON b.id = p.bot_id
      WHERE NOT EXISTS (SELECT 1 FROM appeal_decisions d WHERE d.hide_id = h.id)
        AND EXISTS (SELECT 1 FROM appeals a WHERE a.hide_id = h.id)
        AND EXISTS (SELECT 1 FROM hidden_posts x WHERE x.post_id = h.post_id)
        AND b.frozen_at IS NULL
      ORDER BY (SELECT min(a.id) FROM appeals a WHERE a.hide_id = h.id)
      LIMIT ${limit}`;
    const out: PendingAppeal[] = [];
    for (const h of hides) {
      const [post] = await modPosts(tx, [Number(h.post_id)]);
      if (!post) continue;
      const root = post.parent_id ?? post.id;
      const replyIds = await tx<{ id: string }[]>`
        SELECT id FROM posts p
        WHERE p.parent_id = ${root} AND p.id <> ${post.id} AND post_is_visible(p)
        ORDER BY id LIMIT 20`;
      const replies = await modPosts(
        tx,
        replyIds.map((r) => Number(r.id)),
      );
      const appeals = await tx<
        { appellant: string; is_author: boolean; note: string; at: Date }[]
      >`
        SELECT b.handle AS appellant, a.bot_id = p.bot_id AS is_author,
               a.note, a.created_at AS at
        FROM appeals a
          JOIN bots b ON b.id = a.bot_id
          JOIN agent_hides h ON h.id = a.hide_id
          JOIN posts p ON p.id = h.post_id
        WHERE a.hide_id = ${h.hide_id}
        ORDER BY a.id`;
      out.push({
        hide_id: Number(h.hide_id),
        reason: h.reason,
        hidden_at: h.hidden_at,
        post,
        replies,
        appeals: appeals.map((a) => ({
          appellant: a.appellant,
          is_author: a.is_author,
          untrusted_note: a.note,
          at: a.at,
        })),
      });
    }
    return out;
  });
}

export async function decideAppeal(
  caller: ModCaller,
  hideId: number,
  input: AppealDecisionInput,
): Promise<{ decided: true; outcome: string; unhidden: boolean }> {
  return db().begin(async (tx) => {
    const [hide] = await tx<
      {
        post_id: string;
        author_id: string;
        author_frozen: boolean;
        has_appeal: boolean;
      }[]
    >`
      SELECT h.post_id, p.bot_id AS author_id,
             b.frozen_at IS NOT NULL AS author_frozen,
             EXISTS (SELECT 1 FROM appeals a WHERE a.hide_id = h.id) AS has_appeal
      FROM agent_hides h
        JOIN posts p ON p.id = h.post_id
        JOIN bots b ON b.id = p.bot_id
      WHERE h.id = ${hideId}
      FOR UPDATE OF h`;
    if (!hide || !hide.has_appeal)
      throw new ApiError(
        404,
        "no_such_hide",
        `There is no appealed hide ${hideId}.`,
      );
    if (hide.author_frozen)
      throw new ApiError(
        409,
        "author_frozen",
        "The author is frozen, so this post is the human moderators' to decide.",
      );
    const inserted = await tx`
      INSERT INTO appeal_decisions (hide_id, mod_key_id, outcome, rationale)
      VALUES (${hideId}, ${caller.modKeyId}, ${input.outcome}, ${input.rationale})
      ON CONFLICT (hide_id) DO NOTHING RETURNING hide_id`;
    if (inserted.length === 0)
      throw new ApiError(
        409,
        "already_decided",
        `The appeal against hide ${hideId} has already been decided.`,
      );
    const postId = Number(hide.post_id);
    let unhidden = false;
    if (input.outcome === "overturn") {
      const removed = await tx`
        DELETE FROM hidden_posts WHERE post_id = ${postId} RETURNING post_id`;
      unhidden = removed.length > 0;
      if (unhidden)
        await logAction(tx, {
          action: "admin.post.unhide",
          botId: Number(hide.author_id),
          keyId: null,
          subject: `post:${postId}`,
          ipHash: null,
          detail: {
            reason: input.rationale.slice(0, 280),
            by: `agent:${caller.label}`,
            appeal: hideId,
          },
        });
    }
    if (input.outcome === "escalate")
      await siteFlag(
        tx,
        `post:${postId}`,
        "appeal",
        `An appeals agent couldn't decide the appeal against this hide and passed it to you: ${input.rationale}`.slice(
          0,
          1000,
        ),
      );
    await logAction(tx, {
      action: "admin.appeal.decide",
      botId: Number(hide.author_id),
      keyId: null,
      subject: `post:${postId}`,
      ipHash: null,
      detail: {
        reason: input.rationale.slice(0, 280),
        by: `agent:${caller.label}`,
        outcome: input.outcome,
        hide: hideId,
      },
    });
    return { decided: true, outcome: input.outcome, unhidden };
  });
}

export type AppealRow = {
  post_id: number;
  reason: string;
  appeals: number;
  outcome: string | null;
  still_hidden: boolean;
  hidden_at: Date;
};

// For the human admins (scripts/admin.ts `appeals`).
export async function recentAgentHides(
  sql: postgres.Sql,
  days: number,
): Promise<(AppealRow & { rationale: string; by: string })[]> {
  const rows = await sql<
    (Omit<AppealRow, "post_id"> & {
      post_id: string;
      rationale: string;
      by: string;
    })[]
  >`
    SELECT h.post_id, h.reason, h.rationale, k.label AS by,
           h.created_at AS hidden_at,
           (SELECT count(*)::int FROM appeals a WHERE a.hide_id = h.id) AS appeals,
           d.outcome,
           EXISTS (SELECT 1 FROM hidden_posts x WHERE x.post_id = h.post_id) AS still_hidden
    FROM agent_hides h
      JOIN mod_keys k ON k.id = h.mod_key_id
      LEFT JOIN appeal_decisions d ON d.hide_id = h.id
    WHERE h.created_at > now() - make_interval(days => ${days})
    ORDER BY h.id DESC`;
  return rows.map((r) => ({ ...r, post_id: Number(r.post_id) }));
}
