import type postgres from "postgres";
import type { ModeratorEntry } from "./admin";
import {
  type GateAction,
  gateReport,
  readSignals,
  rulesInForce,
  type Signals,
} from "./gates";
import { HANDLE_RE, parseId } from "./validate";

// What one bot, or one human, has been doing, for an admin deciding whether
// to act: how fast a bot posts and votes, what it wrote, what it was flagged
// for and what moderators did about it before. Admin pages only
// (src/app/admin/), and `npm run admin -- lookup`; nothing a bot or a visitor
// can fetch reads it. Bots' words come back as written, for the page to show
// as plain text.

export type LookupTarget =
  | { kind: "bot"; handle: string }
  | { kind: "bot_id"; id: number }
  | { kind: "human"; id: number };

// "@handle" or "handle", "bot:12", or "human:3", as the moderators' record
// names them.
export function parseLookup(raw: string): LookupTarget | undefined {
  const q = raw.trim();
  const tagged = /^(bot|human):([0-9]+)$/i.exec(q);
  if (tagged) {
    const id = parseId(tagged[2]);
    if (id === undefined) return undefined;
    return tagged[1]?.toLowerCase() === "human"
      ? { kind: "human", id }
      : { kind: "bot_id", id };
  }
  const handle = lookupHandle(q.replace(/^@/, ""));
  return handle === undefined ? undefined : { kind: "bot", handle };
}

// Any handle a bot can have, reserved ones too: the house account has one.
export function lookupHandle(raw: string): string | undefined {
  const h = raw.toLowerCase();
  return HANDLE_RE.test(h) ? h : undefined;
}

export async function handleForBotId(
  sql: postgres.Sql,
  id: number,
): Promise<string | undefined> {
  const [b] = await sql<{ handle: string }[]>`
    SELECT handle FROM bots WHERE id = ${id}`;
  return b?.handle;
}

export type Activity = {
  window: "hour" | "day" | "week" | "all";
  posts: number;
  votes: number;
  reports: number;
};

export type LookupPost = {
  id: number;
  channel: string;
  reply_to: number | null;
  body: string;
  created_at: Date;
  hidden: boolean;
  thread_hidden: boolean;
  channel_hidden: boolean;
  votes: number;
  reports: number;
};

export type Flag = {
  at: Date;
  kind: "duplicate_posts" | "vote_ring_on_its_post" | "voted_with_ring";
  post: number | null;
};

export type BotLookup = {
  id: number;
  handle: string;
  display_name: string | null;
  origin: string | null;
  model: string | null;
  framework: string | null;
  created_at: Date;
  is_house: boolean;
  is_new: boolean;
  frozen_at: Date | null;
  silenced_until: Date | null;
  banned: boolean;
  owner: number | null;
  via_connector: boolean;
  keys: { active: number; revoked: number };
  activity: Activity[];
  // Posts and votes in each of the last 24 hours that had any, newest first.
  by_hour: { hour: Date; posts: number; votes: number }[];
  post_count: number;
  // Posts not hidden themselves; a ban hides these.
  unhidden_posts: number;
  // Channels it made that aren't hidden; a ban hides these too.
  unhidden_channels: number;
  // The newest 50.
  posts: LookupPost[];
  // Channels it made, newest first, and whether each is hidden.
  channels_made: { slug: string; created_at: Date; hidden: boolean }[];
  // The newest 30 it still stands by.
  votes: { post: number; author: string; at: Date; excerpt: string }[];
  // The newest 30 on its posts.
  reports_received: {
    post: number;
    reason: string;
    note: string | null;
    by: string;
    at: Date;
  }[];
  flags: Flag[];
  // Every moderator action on it or its posts, newest first, at most 50.
  history: ModeratorEntry[];
  // The address it signed up from, by the start of its keyed hash, and other
  // bots that signed up from the same one. None for a connector sign-up,
  // whose address is its platform's.
  sign_up_address: { ip: string; others: string[]; other_count: number } | null;
  // What the gates see (src/lib/gates.ts): its trust signals, and for each
  // action whether it clears the rules in force.
  signals: Signals;
  gates: { action: GateAction; open: boolean; gated: boolean }[];
  gate_version: number | null;
};

type BotRow = Omit<
  BotLookup,
  | "id"
  | "keys"
  | "activity"
  | "by_hour"
  | "post_count"
  | "posts"
  | "votes"
  | "reports_received"
  | "flags"
  | "history"
  | "sign_up_address"
  | "signals"
  | "gates"
  | "gate_version"
  | "owner"
> & {
  id: string;
  owner: string | null;
  active_keys: number;
  revoked_keys: number;
  ip_hash: string | null;
};

export async function lookupBot(
  sql: postgres.Sql,
  handle: string,
): Promise<BotLookup | undefined> {
  // One snapshot, so the counts and lists agree with each other.
  return sql.begin("isolation level repeatable read read only", async (tx) => {
    const [b] = await tx<BotRow[]>`
      SELECT b.id, b.handle, b.display_name, b.origin, b.model, b.framework,
        b.created_at, b.is_house, bot_is_new(b) AS is_new, b.frozen_at,
        CASE WHEN b.silenced_until > now() THEN b.silenced_until END AS silenced_until,
        coalesce((
          SELECT action = 'admin.bot.ban' FROM action_log
          WHERE bot_id = b.id AND action IN ('admin.bot.ban', 'admin.bot.unban')
          ORDER BY id DESC LIMIT 1), false) AS banned,
        b.owner_id AS owner,
        coalesce(r.detail->>'via' = 'connector', false) AS via_connector,
        CASE WHEN r.detail->>'via' = 'connector' THEN NULL ELSE r.ip_hash END AS ip_hash,
        (SELECT count(*) FROM api_keys k WHERE k.bot_id = b.id AND k.revoked_at IS NULL)::int AS active_keys,
        (SELECT count(*) FROM api_keys k WHERE k.bot_id = b.id AND k.revoked_at IS NOT NULL)::int AS revoked_keys,
        (SELECT count(*) FROM posts p WHERE p.bot_id = b.id
          AND NOT EXISTS (SELECT 1 FROM hidden_posts h WHERE h.post_id = p.id))::int AS unhidden_posts,
        (SELECT count(*) FROM channels c
          WHERE c.bot_id = b.id AND channel_is_visible(c))::int AS unhidden_channels
      FROM bots b
        LEFT JOIN LATERAL (
          SELECT detail, ip_hash FROM action_log
          WHERE bot_id = b.id AND action = 'bot.register'
          ORDER BY id LIMIT 1) r ON true
      WHERE b.handle = ${handle}`;
    if (!b) return undefined;
    const id = Number(b.id);
    // One pass over the bot's entries for all four windows.
    const [c] = await tx<
      Record<`${"posts" | "votes" | "reports"}_${Activity["window"]}`, number>[]
    >`
      SELECT
        (count(*) FILTER (WHERE action = 'post.create' AND at > now() - interval '1 hour'))::int AS posts_hour,
        (count(*) FILTER (WHERE action = 'post.vote' AND at > now() - interval '1 hour'))::int AS votes_hour,
        (count(*) FILTER (WHERE action = 'post.report' AND at > now() - interval '1 hour'))::int AS reports_hour,
        (count(*) FILTER (WHERE action = 'post.create' AND at > now() - interval '1 day'))::int AS posts_day,
        (count(*) FILTER (WHERE action = 'post.vote' AND at > now() - interval '1 day'))::int AS votes_day,
        (count(*) FILTER (WHERE action = 'post.report' AND at > now() - interval '1 day'))::int AS reports_day,
        (count(*) FILTER (WHERE action = 'post.create' AND at > now() - interval '7 days'))::int AS posts_week,
        (count(*) FILTER (WHERE action = 'post.vote' AND at > now() - interval '7 days'))::int AS votes_week,
        (count(*) FILTER (WHERE action = 'post.report' AND at > now() - interval '7 days'))::int AS reports_week,
        (count(*) FILTER (WHERE action = 'post.create'))::int AS posts_all,
        (count(*) FILTER (WHERE action = 'post.vote'))::int AS votes_all,
        (count(*) FILTER (WHERE action = 'post.report'))::int AS reports_all
      FROM action_log
      WHERE bot_id = ${id} AND action IN ('post.create', 'post.vote', 'post.report')`;
    const activity: Activity[] = (["hour", "day", "week", "all"] as const).map(
      (window) => ({
        window,
        posts: c?.[`posts_${window}`] ?? 0,
        votes: c?.[`votes_${window}`] ?? 0,
        reports: c?.[`reports_${window}`] ?? 0,
      }),
    );
    const byHour = await tx<{ hour: Date; posts: number; votes: number }[]>`
      SELECT date_trunc('hour', at, 'UTC') AS hour,
        (count(*) FILTER (WHERE action = 'post.create'))::int AS posts,
        (count(*) FILTER (WHERE action = 'post.vote'))::int AS votes
      FROM action_log
      WHERE bot_id = ${id} AND action IN ('post.create', 'post.vote')
        AND at > now() - interval '24 hours'
      GROUP BY 1 ORDER BY 1 DESC`;
    const [n] = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM posts WHERE bot_id = ${id}`;
    const posts = await tx<
      (Omit<LookupPost, "id" | "reply_to"> & {
        id: string;
        reply_to: string | null;
      })[]
    >`
      SELECT p.id, c.slug AS channel, p.parent_id AS reply_to, p.body, p.created_at,
        EXISTS (SELECT 1 FROM hidden_posts h WHERE h.post_id = p.id) AS hidden,
        EXISTS (SELECT 1 FROM hidden_posts h WHERE h.post_id = p.parent_id) AS thread_hidden,
        NOT channel_is_visible(c) AS channel_hidden,
        post_votes(p) AS votes,
        (SELECT count(*) FROM reports r WHERE r.post_id = p.id)::int AS reports
      FROM posts p JOIN channels c ON c.id = p.channel_id
      WHERE p.bot_id = ${id}
      ORDER BY p.id DESC LIMIT 50`;
    const channelsMade = await tx<
      { slug: string; created_at: Date; hidden: boolean }[]
    >`
      SELECT c.slug, c.created_at, NOT channel_is_visible(c) AS hidden
      FROM channels c WHERE c.bot_id = ${id}
      ORDER BY c.created_at DESC, c.id DESC LIMIT 30`;
    const votes = await tx<
      { post: string; author: string; at: Date; excerpt: string }[]
    >`
      SELECT v.post_id AS post, a.handle AS author, v.created_at AS at,
             left(p.body, 80) AS excerpt
      FROM votes v JOIN posts p ON p.id = v.post_id JOIN bots a ON a.id = p.bot_id
      WHERE v.bot_id = ${id}
      ORDER BY v.created_at DESC LIMIT 30`;
    const reports = await tx<
      {
        post: string;
        reason: string;
        note: string | null;
        by: string;
        at: Date;
      }[]
    >`
      SELECT r.post_id AS post, r.reason, r.note, rb.handle AS by, r.created_at AS at
      FROM reports r JOIN posts p ON p.id = r.post_id JOIN bots rb ON rb.id = r.bot_id
      WHERE p.bot_id = ${id}
      ORDER BY r.created_at DESC LIMIT 30`;
    // Alerts are few, so each kind is read by its action and matched here.
    // A duplicate-posts alert names its text by a hash of its letters
    // (noticeDuplicatePosts in src/lib/floods.ts); so does this.
    const flags = await tx<(Omit<Flag, "post"> & { post: string | null })[]>`
      SELECT a.at, 'duplicate_posts' AS kind, (a.detail->>'post')::bigint AS post
      FROM action_log a
      WHERE a.action = 'alert.duplicate_posts' AND a.subject IN (
        SELECT 'text:' || left(encode(sha256(convert_to(post_letters(p.body), 'UTF8')), 'hex'), 16)
        FROM (SELECT body FROM posts WHERE bot_id = ${id} ORDER BY id DESC LIMIT 500) p)
      UNION ALL
      SELECT a.at, 'vote_ring_on_its_post', (a.detail->>'post')::bigint
      FROM action_log a
      WHERE a.action = 'alert.vote_ring' AND a.subject IN (
        SELECT 'post:' || id FROM posts WHERE bot_id = ${id})
      UNION ALL
      SELECT a.at, 'voted_with_ring', (a.detail->>'post')::bigint
      FROM action_log a
      WHERE a.action = 'alert.vote_ring' AND a.subject IN (
        SELECT subject FROM action_log WHERE bot_id = ${id} AND action = 'post.vote')
      ORDER BY 1 DESC LIMIT 50`;
    const history = await tx<(Omit<ModeratorEntry, "id"> & { id: string })[]>`
      SELECT id, at, substr(action, 7) AS action, subject,
             detail->>'reason' AS reason, detail->>'by' AS by
      FROM action_log
      WHERE bot_id = ${id} AND action LIKE 'admin.%'
      ORDER BY id DESC LIMIT 50`;
    let signUp: BotLookup["sign_up_address"] = null;
    if (b.ip_hash !== null) {
      const others = await tx<{ handle: string; n: number }[]>`
        SELECT o.handle, count(*) OVER ()::int AS n
        FROM action_log a JOIN bots o ON o.id = a.bot_id
        WHERE a.action = 'bot.register' AND a.ip_hash = ${b.ip_hash}
          AND a.bot_id <> ${id} AND coalesce(a.detail->>'via', '') <> 'connector'
        ORDER BY a.id DESC LIMIT 20`;
      signUp = {
        ip: b.ip_hash.slice(0, 8),
        others: others.map((o) => o.handle),
        other_count: others[0]?.n ?? 0,
      };
    }
    const signals = (await readSignals(tx, id)) ?? {};
    const inForce = await rulesInForce(tx);
    return {
      id,
      handle: b.handle,
      display_name: b.display_name,
      origin: b.origin,
      model: b.model,
      framework: b.framework,
      created_at: b.created_at,
      is_house: b.is_house,
      is_new: b.is_new,
      frozen_at: b.frozen_at,
      silenced_until: b.silenced_until,
      banned: b.banned,
      owner: b.owner === null ? null : Number(b.owner),
      via_connector: b.via_connector,
      keys: { active: b.active_keys, revoked: b.revoked_keys },
      activity,
      by_hour: byHour,
      post_count: n?.n ?? 0,
      unhidden_posts: b.unhidden_posts,
      unhidden_channels: b.unhidden_channels,
      posts: posts.map((p) => ({
        ...p,
        id: Number(p.id),
        reply_to: p.reply_to === null ? null : Number(p.reply_to),
      })),
      channels_made: channelsMade,
      votes: votes.map((v) => ({ ...v, post: Number(v.post) })),
      reports_received: reports.map((r) => ({ ...r, post: Number(r.post) })),
      flags: flags.map((f) => ({
        ...f,
        post: f.post === null ? null : Number(f.post),
      })),
      history: history.map((h) => ({ ...h, id: Number(h.id) })),
      sign_up_address: signUp,
      signals,
      gates: gateReport(inForce.rules, signals),
      gate_version: inForce.version,
    };
  });
}

export type HumanLookup = {
  id: number;
  created_at: Date;
  is_admin: boolean;
  bots: {
    handle: string;
    created_at: Date;
    frozen: boolean;
    silenced: boolean;
    posts: number;
  }[];
  owner_codes: number;
  // Everything they did themselves, newest first, at most 50: owner codes,
  // bots they signed up, claimed or released, and, for an admin, their own
  // changes.
  history: {
    id: number;
    at: Date;
    action: string;
    subject: string;
    reason: string | null;
  }[];
};

// Who a human is to the site: their own tables keep only a sign-in id, so
// this shows no name or email, just what they did and the bots linked to
// them.
export async function lookupHuman(
  sql: postgres.Sql,
  id: number,
): Promise<HumanLookup | undefined> {
  return sql.begin("isolation level repeatable read read only", async (tx) => {
    const [h] = await tx<
      { created_at: Date; is_admin: boolean; owner_codes: number }[]
    >`
      SELECT h.created_at,
        EXISTS (SELECT 1 FROM admins a WHERE a.human_id = h.id) AS is_admin,
        (SELECT count(*) FROM owner_codes c WHERE c.human_id = h.id)::int AS owner_codes
      FROM humans h WHERE h.id = ${id}`;
    if (!h) return undefined;
    const bots = await tx<HumanLookup["bots"]>`
      SELECT b.handle, b.created_at, b.frozen_at IS NOT NULL AS frozen,
        coalesce(b.silenced_until > now(), false) AS silenced,
        (SELECT count(*) FROM posts p WHERE p.bot_id = b.id)::int AS posts
      FROM bots b WHERE b.owner_id = ${id}
      ORDER BY b.created_at DESC`;
    const history = await tx<
      (Omit<HumanLookup["history"][number], "id"> & { id: string })[]
    >`
      SELECT id, at, action, subject, detail->>'reason' AS reason
      FROM action_log WHERE human_id = ${id}
      ORDER BY id DESC LIMIT 50`;
    return {
      id,
      created_at: h.created_at,
      is_admin: h.is_admin,
      bots,
      owner_codes: h.owner_codes,
      history: history.map((e) => ({ ...e, id: Number(e.id) })),
    };
  });
}
