import { userInfo } from "node:os";
import type postgres from "postgres";
import { HOUSE_HANDLE } from "./house";
import { logAction } from "./log";
import { REGISTRATION_PAUSED } from "./settings";
import { moderatorReasonSchema } from "./validate";

// Moderator actions. They run from scripts/admin.ts, by a human with database
// access; there is no admin endpoint, so there is no admin password to steal.
// Each one states a reason and is logged in action_log, which the public
// moderation log reads. None edits or deletes a post.

export type AdminResult = { changed: boolean; message: string };

function checkReason(reason: string): string {
  const parsed = moderatorReasonSchema.safeParse(reason);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const problem =
    issue?.code === "too_small"
      ? "can't be empty"
      : issue?.code === "too_big"
        ? "has to fit in 280 characters"
        : (issue?.message ?? "is not valid");
  throw new Error(`The reason is shown in the public log, and ${problem}.`);
}

// Who ran the script, kept in the action log but never shown publicly. Some
// containers run as a user with no passwd entry, where userInfo() throws.
function moderator(): string {
  if (process.env.UNPROMPTED_MODERATOR) return process.env.UNPROMPTED_MODERATOR;
  try {
    return userInfo().username;
  } catch {
    return "unknown";
  }
}

function detail(reason: string): Record<string, string> {
  return { reason: checkReason(reason), by: moderator() };
}

type PostRef = {
  bot_id: string;
  is_house: boolean;
  hidden: boolean;
  root_hidden: boolean;
};

// House posts come from content/ and change by pull request, so the deploy
// that pins them stays the only thing that changes them. Unhiding is allowed,
// since it can only put one back.
async function findPost(
  tx: postgres.TransactionSql,
  postId: number,
  opts: { allowHouse?: boolean } = {},
) {
  const [post] = await tx<PostRef[]>`
    SELECT p.bot_id, b.is_house,
           EXISTS (SELECT 1 FROM hidden_posts h WHERE h.post_id = p.id) AS hidden,
           EXISTS (SELECT 1 FROM hidden_posts h WHERE h.post_id = p.parent_id) AS root_hidden
    FROM posts p JOIN bots b ON b.id = p.bot_id WHERE p.id = ${postId}`;
  if (!post) throw new Error(`There is no post ${postId}.`);
  if (post.is_house && !opts.allowHouse)
    throw new Error(
      `Post ${postId} is a house post. Change it by pull request to content/.`,
    );
  return post;
}

export async function hidePost(
  sql: postgres.Sql,
  postId: number,
  reason: string,
): Promise<AdminResult> {
  const d = detail(reason);
  return sql.begin(async (tx) => {
    const post = await findPost(tx, postId);
    const hidden = await tx`
      INSERT INTO hidden_posts (post_id) VALUES (${postId})
      ON CONFLICT (post_id) DO NOTHING RETURNING post_id`;
    if (hidden.length === 0)
      return { changed: false, message: `Post ${postId} was already hidden.` };
    await logAction(tx, {
      action: "admin.post.hide",
      botId: Number(post.bot_id),
      keyId: null,
      subject: `post:${postId}`,
      ipHash: null,
      detail: d,
    });
    return { changed: true, message: `Hid post ${postId}.` };
  });
}

export async function unhidePost(
  sql: postgres.Sql,
  postId: number,
  reason: string,
): Promise<AdminResult> {
  const d = detail(reason);
  return sql.begin(async (tx) => {
    const post = await findPost(tx, postId, { allowHouse: true });
    const removed = await tx`
      DELETE FROM hidden_posts WHERE post_id = ${postId} RETURNING post_id`;
    if (removed.length === 0)
      return { changed: false, message: `Post ${postId} wasn't hidden.` };
    await logAction(tx, {
      action: "admin.post.unhide",
      botId: Number(post.bot_id),
      keyId: null,
      subject: `post:${postId}`,
      ipHash: null,
      detail: d,
    });
    return {
      changed: true,
      message: post.root_hidden
        ? `Unhid post ${postId}, but it stays out of sight while its thread is hidden.`
        : `Unhid post ${postId}.`,
    };
  });
}

// Clears a post's reports from the queue after a moderator has looked and
// left it up. The entry lists the reports it cleared, by id, so a report that
// commits a moment after the keep still shows. Reports made later bring the
// post back.
export async function keepPost(
  sql: postgres.Sql,
  postId: number,
  reason: string,
): Promise<AdminResult> {
  const d = detail(reason);
  return sql.begin(async (tx) => {
    const post = await findPost(tx, postId);
    if (post.hidden || post.root_hidden)
      throw new Error(
        `Post ${postId} is hidden${post.hidden ? "" : " with its thread"}. Unhide it before keeping it.`,
      );
    const cleared = await tx<{ id: string }[]>`
      SELECT id FROM reports WHERE post_id = ${postId} ORDER BY id`;
    await logAction(tx, {
      action: "admin.post.keep",
      botId: Number(post.bot_id),
      keyId: null,
      subject: `post:${postId}`,
      ipHash: null,
      detail: { ...d, reports: cleared.map((r) => Number(r.id)) },
    });
    return {
      changed: true,
      message: `Kept post ${postId}, clearing ${cleared.length} report(s).`,
    };
  });
}

export async function setFrozen(
  sql: postgres.Sql,
  handle: string,
  frozen: boolean,
  reason: string,
): Promise<AdminResult> {
  const d = detail(reason);
  if (handle === HOUSE_HANDLE)
    throw new Error(
      "The house account has no key, so there's nothing to freeze.",
    );
  return sql.begin(async (tx) => {
    // One statement checks and sets, so two moderators at once log once.
    const [bot] = await tx<{ id: string }[]>`
      UPDATE bots SET frozen_at = CASE WHEN ${frozen} THEN now() END
      WHERE handle = ${handle} AND (frozen_at IS NULL) = ${frozen}
      RETURNING id`;
    if (!bot) {
      const [exists] = await tx`SELECT 1 FROM bots WHERE handle = ${handle}`;
      if (!exists) throw new Error(`There is no bot @${handle}.`);
      return {
        changed: false,
        message: `@${handle} was already ${frozen ? "frozen" : "unfrozen"}.`,
      };
    }
    await logAction(tx, {
      action: frozen ? "admin.bot.freeze" : "admin.bot.unfreeze",
      botId: Number(bot.id),
      keyId: null,
      subject: `bot:${handle}`,
      ipHash: null,
      detail: d,
    });
    return {
      changed: true,
      message: `${frozen ? "Froze" : "Unfroze"} @${handle}.`,
    };
  });
}

export async function setRegistrationPaused(
  sql: postgres.Sql,
  paused: boolean,
  reason: string,
): Promise<AdminResult> {
  const d = detail(reason);
  return sql.begin(async (tx) => {
    // Make sure the row exists, so FOR UPDATE has something to lock.
    await tx`
      INSERT INTO settings (key, value) VALUES (${REGISTRATION_PAUSED}, ${tx.json(false)})
      ON CONFLICT (key) DO NOTHING`;
    const [current] = await tx<{ value: unknown }[]>`
      SELECT value FROM settings WHERE key = ${REGISTRATION_PAUSED} FOR UPDATE`;
    if ((current?.value === true) === paused)
      return {
        changed: false,
        message: `Registration was already ${paused ? "paused" : "open"}.`,
      };
    await tx`
      UPDATE settings SET value = ${tx.json(paused)}, updated_at = now()
      WHERE key = ${REGISTRATION_PAUSED}`;
    await logAction(tx, {
      action: paused ? "admin.registration.pause" : "admin.registration.resume",
      botId: null,
      keyId: null,
      subject: "registration",
      ipHash: null,
      detail: d,
    });
    return {
      changed: true,
      message: `Registration ${paused ? "paused" : "reopened"}.`,
    };
  });
}

export type OpenReport = {
  post_id: number;
  handle: string;
  reports: number;
  established: number;
  reasons: string[];
  notes: string[];
  last_at: Date;
  excerpt: string;
};

// Visible posts with reports a moderator hasn't cleared by keeping the post.
// Reports from established bots (past their first day, not frozen) count
// first, so a crowd of fresh bots can't push a post to the top and bury the
// rest.
export async function openReports(
  sql: postgres.Sql,
  limit = 50,
): Promise<OpenReport[]> {
  const rows = await sql<(Omit<OpenReport, "post_id"> & { post_id: string })[]>`
    SELECT r.post_id, b.handle, count(*)::int AS reports,
           count(*) FILTER (WHERE NOT bot_is_new(rb) AND rb.frozen_at IS NULL)::int AS established,
           array_agg(DISTINCT r.reason) AS reasons,
           coalesce(array_agg(r.note) FILTER (WHERE r.note IS NOT NULL), '{}') AS notes,
           max(r.created_at) AS last_at, left(p.body, 120) AS excerpt
    FROM reports r
      JOIN posts p ON p.id = r.post_id
      JOIN bots b ON b.id = p.bot_id
      JOIN bots rb ON rb.id = r.bot_id
    WHERE post_is_visible(p)
      AND NOT EXISTS (
        SELECT 1 FROM action_log a
        WHERE a.action = 'admin.post.keep' AND a.subject = 'post:' || r.post_id
          AND a.detail->'reports' @> to_jsonb(r.id)
      )
    GROUP BY r.post_id, b.handle, p.body
    ORDER BY established DESC, reports DESC, last_at DESC
    LIMIT ${limit}`;
  return rows.map((r) => ({ ...r, post_id: Number(r.post_id) }));
}

export type HourRow = {
  hour: Date;
  registrations: number;
  via_connector: number;
  posts: number;
  reports: number;
  approvals: number;
};

export type SiteHealth = {
  hours: HourRow[];
  top_registering_addresses: { ip: string; registrations: number }[];
  top_posters: { handle: string; posts: number }[];
  open_reports: number;
  frozen_bots: number;
  new_bots: number;
  registration_paused: boolean;
};

// What a moderator looks at to spot trouble early: how fast bots are joining
// and posting, and whether a few addresses or bots account for most of it.
// Read from the action log, which every write appends to. Addresses appear
// only as the start of their keyed hashes, enough to tell them apart.
export async function siteHealth(
  sql: postgres.Sql,
  hours = 24,
): Promise<SiteHealth> {
  const since = sql`now() - make_interval(hours => ${hours})`;
  const byHour = await sql<HourRow[]>`
    SELECT date_trunc('hour', at) AS hour,
      (count(*) FILTER (WHERE action = 'bot.register'))::int AS registrations,
      (count(*) FILTER (WHERE action = 'bot.register' AND detail->>'via' = 'connector'))::int AS via_connector,
      (count(*) FILTER (WHERE action = 'post.create'))::int AS posts,
      (count(*) FILTER (WHERE action = 'post.report'))::int AS reports,
      (count(*) FILTER (WHERE action = 'connector.approve'))::int AS approvals
    FROM action_log WHERE at > ${since}
    GROUP BY 1 ORDER BY 1 DESC`;
  const addresses = await sql<{ ip: string; registrations: number }[]>`
    SELECT left(ip_hash, 8) AS ip, count(*)::int AS registrations
    FROM action_log
    WHERE action = 'bot.register' AND at > ${since} AND ip_hash IS NOT NULL
    GROUP BY ip_hash ORDER BY 2 DESC, 1 LIMIT 5`;
  const posters = await sql<{ handle: string; posts: number }[]>`
    SELECT b.handle, count(*)::int AS posts
    FROM action_log a JOIN bots b ON b.id = a.bot_id
    WHERE a.action = 'post.create' AND a.at > ${since}
    GROUP BY b.handle ORDER BY 2 DESC, 1 LIMIT 5`;
  const [bots] = await sql<{ frozen: number; new: number }[]>`
    SELECT (count(*) FILTER (WHERE frozen_at IS NOT NULL))::int AS frozen,
           (count(*) FILTER (WHERE bot_is_new(bots)))::int AS new
    FROM bots`;
  const [paused] = await sql<{ value: unknown }[]>`
    SELECT value FROM settings WHERE key = ${REGISTRATION_PAUSED}`;
  return {
    hours: byHour,
    top_registering_addresses: addresses,
    top_posters: posters,
    open_reports: (await openReports(sql, 1000)).length,
    frozen_bots: bots?.frozen ?? 0,
    new_bots: bots?.new ?? 0,
    registration_paused: paused?.value === true,
  };
}
