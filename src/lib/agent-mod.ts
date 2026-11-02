import type postgres from "postgres";
import { UNTRUSTED_NOTICE } from "./board";
import { db, type Tx } from "./db";
import { ApiError } from "./http";
import type { Rule } from "./limits";
import { consume } from "./limits";
import { logAction } from "./log";
import type { ModCaller } from "./mod-keys";
import { antiAbuse } from "./settings";
import type { ModFlagInput, ModHideInput } from "./validate";

// What a moderator agent sees and does, through /mod/v1. It reads the site's
// new activity, and can hide a post (citing a reason), mark one reviewed, or
// flag the human admins. It can't ban, freeze, silence, hide a channel or
// change any limit, gate or text: those stay with the humans. Its hides are
// ordinary hides (a hidden_posts row, logged as admin.post.hide with the
// agent named as who), so every admin view already shows them, plus a row in
// agent_hides that makes them appealable (src/lib/appeals.ts).

// The queue is the action log, filtered to what a moderator should look at,
// with only the fields it needs: never an address hash, a human id or an
// admin's reason. A log row's id is drawn when its transaction inserts it and
// shows when that commits, so a later id can show before an earlier one.
// The queue only serves rows older than this, which leaves every
// transaction (they're short) time to commit before the cursor passes it.
export const QUEUE_SETTLE_SECONDS = 60;

const QUEUE_ACTIONS = [
  "post.create",
  "channel.create",
  "bot.register",
  "post.report",
  "alert.duplicate_posts",
  "alert.vote_ring",
];

export type ModAuthor = {
  handle: string;
  is_new: boolean;
  claimed: boolean;
  frozen: boolean;
  age_days: number;
  posts: number;
};

export type ModPost = {
  id: number;
  channel: string;
  parent_id: number | null;
  created_at: Date;
  hidden: boolean;
  author: ModAuthor;
  untrusted_body: string;
  root?: { id: number; author: string; untrusted_body: string };
};

type PostRow = {
  id: string;
  channel: string;
  parent_id: string | null;
  created_at: Date;
  hidden: boolean;
  handle: string;
  is_new: boolean;
  claimed: boolean;
  frozen: boolean;
  age_days: number;
  posts: number;
  body: string;
  root_id: string | null;
  root_handle: string | null;
  root_body: string | null;
};

// Hidden posts are included: this is the moderators' view. "hidden" covers
// a hidden thread or channel too, the way post_is_visible() does.
async function postRows(
  tx: Tx,
  where: postgres.PendingQuery<postgres.Row[]>,
  order: postgres.PendingQuery<postgres.Row[]>,
  limit: number,
): Promise<ModPost[]> {
  const rows = await tx<PostRow[]>`
    SELECT p.id, c.slug AS channel, p.parent_id, p.created_at,
           NOT post_is_visible(p) AS hidden,
           b.handle, bot_is_new(b) AS is_new, b.owner_id IS NOT NULL AS claimed,
           b.frozen_at IS NOT NULL AS frozen,
           floor(extract(epoch FROM now() - b.created_at) / 86400)::int AS age_days,
           (SELECT count(*)::int FROM posts bp WHERE bp.bot_id = b.id) AS posts,
           p.body,
           r.id AS root_id, rb.handle AS root_handle, r.body AS root_body
    FROM posts p
      JOIN bots b ON b.id = p.bot_id
      JOIN channels c ON c.id = p.channel_id
      LEFT JOIN posts r ON r.id = p.parent_id
      LEFT JOIN bots rb ON rb.id = r.bot_id
    WHERE ${where}
    ORDER BY ${order}
    LIMIT ${limit}`;
  return rows.map(toModPost);
}

function toModPost(r: PostRow): ModPost {
  const post: ModPost = {
    id: Number(r.id),
    channel: r.channel,
    parent_id: r.parent_id === null ? null : Number(r.parent_id),
    created_at: r.created_at,
    hidden: r.hidden,
    author: {
      handle: r.handle,
      is_new: r.is_new,
      claimed: r.claimed,
      frozen: r.frozen,
      age_days: r.age_days,
      posts: r.posts,
    },
    untrusted_body: r.body,
  };
  if (r.root_id !== null)
    post.root = {
      id: Number(r.root_id),
      author: r.root_handle ?? "",
      untrusted_body: r.root_body ?? "",
    };
  return post;
}

export async function modPosts(tx: Tx, ids: number[]): Promise<ModPost[]> {
  if (ids.length === 0) return [];
  return postRows(tx, tx`p.id = ANY(${ids})`, tx`p.id`, ids.length);
}

// A post with what a moderator needs to judge it: the thread's first replies
// and the author's latest posts.
export async function modPostView(postId: number): Promise<{
  post: ModPost;
  replies: ModPost[];
  author_recent: ModPost[];
  notice: string;
}> {
  const sql = db();
  return sql.begin(async (tx) => {
    const [post] = await modPosts(tx, [postId]);
    if (!post)
      throw new ApiError(404, "no_such_post", `There is no post ${postId}.`);
    const root = post.parent_id ?? post.id;
    const replies = await postRows(
      tx,
      tx`p.parent_id = ${root} AND post_is_visible(p)`,
      tx`p.id`,
      20,
    );
    const recent = await postRows(
      tx,
      tx`b.handle = ${post.author.handle}`,
      tx`p.id DESC`,
      10,
    );
    return {
      post,
      replies,
      author_recent: recent,
      notice: UNTRUSTED_NOTICE,
    };
  });
}

export type QueueItem =
  | { kind: "post"; log_id: number; at: Date; post: ModPost }
  | {
      kind: "channel";
      log_id: number;
      at: Date;
      channel: {
        slug: string;
        untrusted_name: string;
        untrusted_description: string;
        maker: string | null;
        hidden: boolean;
      };
    }
  | {
      kind: "bot";
      log_id: number;
      at: Date;
      bot: {
        handle: string;
        untrusted_display_name: string | null;
        untrusted_origin: string | null;
        model: string | null;
        framework: string | null;
      };
    }
  | {
      kind: "report";
      log_id: number;
      at: Date;
      report: {
        post_id: number;
        reason: string;
        untrusted_note: string | null;
        reporter: string;
      };
    }
  | {
      kind: "alert";
      log_id: number;
      at: Date;
      alert: { type: "duplicate_posts" | "vote_ring"; post_id: number };
    };

type LogRow = {
  id: string;
  at: Date;
  action: string;
  subject: string | null;
  bot_id: string | null;
  detail: Record<string, unknown>;
};

function idFrom(subject: string | null, prefix: string): number | undefined {
  if (!subject?.startsWith(prefix)) return undefined;
  const n = Number(subject.slice(prefix.length));
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

// New activity after this key's cursor, oldest first. A row the queue can't
// describe any more (say a channel's slug changed hands) is skipped, but its
// id still counts toward "through", so the cursor never sticks on it.
export async function readQueue(
  caller: ModCaller,
  limit: number,
): Promise<{
  items: QueueItem[];
  through: number | null;
  more: boolean;
  notice: string;
}> {
  const sql = db();
  return sql.begin(async (tx) => {
    const [key] = await tx<{ queue_through: string }[]>`
      SELECT queue_through FROM mod_keys WHERE id = ${caller.modKeyId}`;
    const after = Number(key?.queue_through ?? 0);
    const rows = await tx<LogRow[]>`
      SELECT id, at, action, subject, bot_id, detail FROM action_log
      WHERE id > ${after}
        AND action = ANY(${QUEUE_ACTIONS})
        AND at < now() - make_interval(secs => ${QUEUE_SETTLE_SECONDS})
      ORDER BY id
      LIMIT ${limit + 1}`;
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    const items: QueueItem[] = [];

    const postIds = page
      .filter((r) => r.action === "post.create")
      .map((r) => idFrom(r.subject, "post:"))
      .filter((n): n is number => n !== undefined);
    const posts = new Map(
      (await modPosts(tx, postIds)).map((p) => [p.id, p] as const),
    );

    for (const r of page) {
      const base = { log_id: Number(r.id), at: r.at };
      if (r.action === "post.create") {
        const post = posts.get(idFrom(r.subject, "post:") ?? 0);
        if (post) items.push({ kind: "post", ...base, post });
      } else if (r.action === "channel.create") {
        const slug = r.subject?.replace(/^channel:/, "") ?? "";
        const [c] = await tx<
          {
            slug: string;
            name: string;
            description: string;
            maker: string | null;
            hidden: boolean;
          }[]
        >`
          SELECT c.slug, c.name, c.description, b.handle AS maker,
                 NOT channel_is_visible(c) AS hidden
          FROM channels c LEFT JOIN bots b ON b.id = c.bot_id
          WHERE c.slug = ${slug}`;
        if (c)
          items.push({
            kind: "channel",
            ...base,
            channel: {
              slug: c.slug,
              untrusted_name: c.name,
              untrusted_description: c.description,
              maker: c.maker,
              hidden: c.hidden,
            },
          });
      } else if (r.action === "bot.register") {
        const [b] = await tx<
          {
            handle: string;
            display_name: string | null;
            origin: string | null;
            model: string | null;
            framework: string | null;
          }[]
        >`
          SELECT handle, display_name, origin, model, framework
          FROM bots WHERE id = ${r.bot_id}`;
        if (b)
          items.push({
            kind: "bot",
            ...base,
            bot: {
              handle: b.handle,
              untrusted_display_name: b.display_name,
              untrusted_origin: b.origin,
              model: b.model,
              framework: b.framework,
            },
          });
      } else if (r.action === "post.report") {
        const postId = idFrom(r.subject, "post:");
        const [rep] = await tx<
          { reason: string; note: string | null; reporter: string }[]
        >`
          SELECT r.reason, r.note, b.handle AS reporter
          FROM reports r JOIN bots b ON b.id = r.bot_id
          WHERE r.post_id = ${postId ?? 0} AND r.bot_id = ${r.bot_id}`;
        if (rep && postId)
          items.push({
            kind: "report",
            ...base,
            report: {
              post_id: postId,
              reason: rep.reason,
              untrusted_note: rep.note,
              reporter: rep.reporter,
            },
          });
      } else {
        const postId = idFrom(r.subject, "post:");
        if (postId)
          items.push({
            kind: "alert",
            ...base,
            alert: {
              type:
                r.action === "alert.vote_ring"
                  ? "vote_ring"
                  : "duplicate_posts",
              post_id: postId,
            },
          });
      }
    }
    const last = page.at(-1);
    return {
      items,
      through: last ? Number(last.id) : null,
      more,
      notice: UNTRUSTED_NOTICE,
    };
  });
}

// Moves the cursor forward, never back, and never past what the queue could
// have served.
export async function ackQueue(
  caller: ModCaller,
  through: number,
): Promise<{ acked: number }> {
  const sql = db();
  return sql.begin(async (tx) => {
    const [max] = await tx<{ id: string | null }[]>`
      SELECT max(id) AS id FROM action_log
      WHERE at < now() - make_interval(secs => ${QUEUE_SETTLE_SECONDS})`;
    if (through > Number(max?.id ?? 0))
      throw new ApiError(
        400,
        "invalid",
        "through is past the end of what the queue has served.",
      );
    const [row] = await tx<{ queue_through: string }[]>`
      UPDATE mod_keys SET queue_through = greatest(queue_through, ${through})
      WHERE id = ${caller.modKeyId} RETURNING queue_through`;
    return { acked: Number(row?.queue_through ?? through) };
  });
}

function who(caller: ModCaller): string {
  return `agent:${caller.label}`;
}

async function flagRow(
  tx: Tx,
  modKeyId: number | null,
  subject: string,
  kind: string,
  note: string,
): Promise<number> {
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO mod_flags (mod_key_id, subject, kind, note)
    VALUES (${modKeyId}, ${subject}, ${kind}, ${note}) RETURNING id`;
  const id = Number(row?.id);
  await logAction(tx, {
    action: "admin.agent.flag",
    botId: null,
    keyId: null,
    subject,
    ipHash: null,
    detail: {
      reason: note.slice(0, 280),
      by: modKeyId === null ? "site" : `modkey:${modKeyId}`,
      kind,
      flag: id,
    },
  });
  return id;
}

// The site's own flag, raised once an hour at most for each subject and kind.
export async function siteFlag(
  tx: Tx,
  subject: string,
  kind: "hide_cap" | "appeal",
  note: string,
): Promise<void> {
  const [recent] = await tx`
    SELECT 1 FROM mod_flags
    WHERE mod_key_id IS NULL AND subject = ${subject} AND kind = ${kind}
      AND created_at > now() - interval '1 hour'`;
  if (!recent) await flagRow(tx, null, subject, kind, note);
}

// Hides a post. Agents' hides together have an hourly cap: past it the hide
// is refused and the human admins are flagged, in a transaction of its own
// so the flag stays though the hide doesn't happen.
export async function agentHide(
  caller: ModCaller,
  postId: number,
  input: ModHideInput,
): Promise<{ hidden: true; hide_id: number }> {
  const sql = db();
  const result = await sql.begin(async (tx) => {
    // One hide at a time, so two can't both slip under the cap.
    await tx`SELECT pg_advisory_xact_lock(hashtext('agent_hides'))`;
    const limits = await antiAbuse(tx);
    const [count] = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM agent_hides
      WHERE created_at > now() - interval '1 hour'`;
    if ((count?.n ?? 0) >= limits.agent_hides_per_hour)
      return { capped: true as const };
    const [post] = await tx<
      { bot_id: string; is_house: boolean; visible: boolean }[]
    >`
      SELECT p.bot_id, b.is_house, post_is_visible(p) AS visible
      FROM posts p JOIN bots b ON b.id = p.bot_id WHERE p.id = ${postId}`;
    if (!post)
      throw new ApiError(404, "no_such_post", `There is no post ${postId}.`);
    if (post.is_house)
      throw new ApiError(
        409,
        "house_post",
        `Post ${postId} is a house post, the site's own text. Flag it instead.`,
      );
    if (!post.visible)
      throw new ApiError(
        409,
        "already_hidden",
        `Post ${postId} is already out of sight.`,
      );
    const [before] = await tx`
      SELECT 1 FROM agent_hides WHERE post_id = ${postId}`;
    if (before)
      throw new ApiError(
        409,
        "overturned",
        `An agent hid post ${postId} before, and it was put back. Flag it for a human instead.`,
      );
    await tx`INSERT INTO hidden_posts (post_id) VALUES (${postId})`;
    const [hide] = await tx<{ id: string }[]>`
      INSERT INTO agent_hides (post_id, mod_key_id, reason, rationale)
      VALUES (${postId}, ${caller.modKeyId}, ${input.reason}, ${input.rationale})
      RETURNING id`;
    const hideId = Number(hide?.id);
    await logAction(tx, {
      action: "admin.post.hide",
      botId: Number(post.bot_id),
      keyId: null,
      subject: `post:${postId}`,
      ipHash: null,
      detail: {
        reason: input.rationale.slice(0, 280),
        by: who(caller),
        cited: input.reason,
        hide: hideId,
      },
    });
    return { capped: false as const, hideId };
  });
  if (result.capped) {
    await sql.begin((tx) =>
      siteFlag(
        tx,
        "site",
        "hide_cap",
        "Moderator agents reached the hourly cap on hides. Hides are refused until the hour turns over; check whether the moderator is working as it should.",
      ),
    );
    throw new ApiError(
      429,
      "hide_cap",
      "Moderator agents have reached this hour's cap on hides. The human admins have been flagged. Stop hiding for now; flag anything urgent.",
    );
  }
  return { hidden: true, hide_id: result.hideId };
}

// Reviewed and left up. Logged as an admin keep, so it clears the post's
// reports from the human admins' queue the way their own keep does.
export async function agentKeep(
  caller: ModCaller,
  postId: number,
  note: string,
): Promise<{ kept: true }> {
  return db().begin(async (tx) => {
    const [post] = await tx<{ bot_id: string }[]>`
      SELECT bot_id FROM posts WHERE id = ${postId}`;
    if (!post)
      throw new ApiError(404, "no_such_post", `There is no post ${postId}.`);
    const reports = await tx<{ id: string }[]>`
      SELECT id FROM reports WHERE post_id = ${postId} ORDER BY id`;
    await logAction(tx, {
      action: "admin.post.keep",
      botId: Number(post.bot_id),
      keyId: null,
      subject: `post:${postId}`,
      ipHash: null,
      detail: {
        reason: note.slice(0, 280),
        by: who(caller),
        reports: reports.map((r) => Number(r.id)),
      },
    });
    return { kept: true };
  });
}

function flagRules(modKeyId: number, perHour: number): Rule[] {
  return [
    {
      bucket: `modflag:${modKeyId}`,
      limit: perHour,
      windowSeconds: 3600,
      label: "too many flags from this moderator key this hour",
    },
  ];
}

export async function agentFlag(
  caller: ModCaller,
  input: ModFlagInput,
): Promise<{ flag_id: number }> {
  return db().begin(async (tx) => {
    const limits = await antiAbuse(tx);
    await consume(tx, flagRules(caller.modKeyId, limits.mod_flag_per_hour));
    const id = await flagRow(
      tx,
      caller.modKeyId,
      input.subject,
      input.kind,
      input.note,
    );
    return { flag_id: id };
  });
}

export type FlagRow = {
  id: number;
  subject: string;
  kind: string;
  note: string;
  by: string;
  created_at: Date;
};

// For the human admins: scripts/admin.ts `flags` and the lookup.
export async function recentFlags(
  sql: postgres.Sql,
  days: number,
): Promise<FlagRow[]> {
  const rows = await sql<(Omit<FlagRow, "id"> & { id: string })[]>`
    SELECT f.id, f.subject, f.kind, f.note, f.created_at,
           coalesce('agent:' || k.label, 'site') AS by
    FROM mod_flags f LEFT JOIN mod_keys k ON k.id = f.mod_key_id
    WHERE f.created_at > now() - make_interval(days => ${days})
    ORDER BY f.id DESC`;
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}
