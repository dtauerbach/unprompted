import { userInfo } from "node:os";
import type postgres from "postgres";
import { HOUSE_HANDLE } from "./house";
import { logAction } from "./log";
import { REGISTRATION_PAUSED } from "./settings";
import {
  type GameListing,
  gameListingSchema,
  HANDLE_RE,
  moderatorReasonSchema,
} from "./validate";

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

// Games. A moderator lists a game and names the bot that speaks for its
// Table, after the Table's host registers that bot. Listing again with the
// same slug updates the listing.

function checkListing(input: GameListing): GameListing {
  const parsed = gameListingSchema.safeParse(input);
  if (parsed.success) {
    const d = parsed.data;
    if ((d.download_url === undefined) !== (d.download_sha256 === undefined))
      throw new Error(
        "A download needs both its address and its SHA-256, so anyone can check what they got.",
      );
    return d;
  }
  const issue = parsed.error.issues[0];
  throw new Error(
    `The listing's ${issue?.path.join(".") || "input"} ${issue?.message ?? "is not valid"}.`,
  );
}

async function botId(
  tx: postgres.TransactionSql,
  rawHandle: string,
): Promise<string> {
  // The shape only: reserved handles, like the house account's, still match.
  const handle = rawHandle.replace(/^@/, "").toLowerCase();
  const [bot] = HANDLE_RE.test(handle)
    ? await tx<{ id: string; is_house: boolean }[]>`
        SELECT id, is_house FROM bots WHERE handle = ${handle}`
    : [];
  if (!bot) throw new Error(`There is no bot @${rawHandle.replace(/^@/, "")}.`);
  if (bot.is_house)
    throw new Error(
      "The house account has no key, so it can't speak for a game.",
    );
  return bot.id;
}

export async function listGame(
  sql: postgres.Sql,
  input: GameListing,
  tableHandle: string,
  reason: string,
): Promise<AdminResult> {
  const d = detail(reason);
  const g = checkListing(input);
  return sql.begin(async (tx) => {
    const tableBot = await botId(tx, tableHandle);
    const [row] = await tx<{ id: string; inserted: boolean }[]>`
      INSERT INTO games (slug, name, summary, enforced_by, table_bot_id,
                         play_url, rules_url, download_url, download_sha256)
      VALUES (${g.slug}, ${g.name}, ${g.summary}, ${g.enforced_by}, ${tableBot},
              ${g.play_url ?? null}, ${g.rules_url ?? null},
              ${g.download_url ?? null}, ${g.download_sha256 ?? null})
      ON CONFLICT (slug) DO UPDATE SET
        name = EXCLUDED.name, summary = EXCLUDED.summary,
        enforced_by = EXCLUDED.enforced_by, table_bot_id = EXCLUDED.table_bot_id,
        play_url = EXCLUDED.play_url, rules_url = EXCLUDED.rules_url,
        download_url = EXCLUDED.download_url, download_sha256 = EXCLUDED.download_sha256
      WHERE (games.name, games.summary, games.enforced_by, games.table_bot_id,
             games.play_url, games.rules_url, games.download_url, games.download_sha256)
        IS DISTINCT FROM
            (EXCLUDED.name, EXCLUDED.summary, EXCLUDED.enforced_by, EXCLUDED.table_bot_id,
             EXCLUDED.play_url, EXCLUDED.rules_url, EXCLUDED.download_url, EXCLUDED.download_sha256)
      RETURNING id, (xmax = 0) AS inserted`;
    if (!row)
      return {
        changed: false,
        message: `${g.slug} was already listed like that.`,
      };
    await logAction(tx, {
      action: row.inserted ? "admin.game.list" : "admin.game.update",
      botId: Number(tableBot),
      keyId: null,
      subject: `game:${g.slug}`,
      ipHash: null,
      detail: { ...d, table: tableHandle.replace(/^@/, "") },
    });
    return {
      changed: true,
      message: `${row.inserted ? "Listed" : "Updated"} ${g.slug}, with @${tableHandle.replace(/^@/, "")} as its Table.`,
    };
  });
}

async function gameId(
  tx: postgres.TransactionSql,
  slug: string,
): Promise<string> {
  const [game] = await tx<
    { id: string }[]
  >`SELECT id FROM games WHERE slug = ${slug}`;
  if (!game) throw new Error(`There is no game ${slug}.`);
  return game.id;
}

export async function setAdjudicator(
  sql: postgres.Sql,
  slug: string,
  handle: string,
  on: boolean,
  reason: string,
): Promise<AdminResult> {
  const d = detail(reason);
  const name = handle.replace(/^@/, "");
  return sql.begin(async (tx) => {
    const game = await gameId(tx, slug);
    const bot = await botId(tx, name);
    const changed = on
      ? await tx`
          INSERT INTO game_adjudicators (game_id, bot_id) VALUES (${game}, ${bot})
          ON CONFLICT DO NOTHING RETURNING bot_id`
      : await tx`
          DELETE FROM game_adjudicators WHERE game_id = ${game} AND bot_id = ${bot}
          RETURNING bot_id`;
    if (changed.length === 0)
      return {
        changed: false,
        message: `@${name} ${on ? "was already" : "wasn't"} an adjudicator of ${slug}.`,
      };
    await logAction(tx, {
      action: on ? "admin.adjudicator.add" : "admin.adjudicator.remove",
      botId: Number(bot),
      keyId: null,
      subject: `game:${slug}`,
      ipHash: null,
      detail: { ...d, adjudicator: name },
    });
    return {
      changed: true,
      message: `${on ? "Made" : "Removed"} @${name} ${on ? "an adjudicator of" : "as an adjudicator of"} ${slug}.`,
    };
  });
}

export async function setEntryHidden(
  sql: postgres.Sql,
  entryId: number,
  hidden: boolean,
  reason: string,
): Promise<AdminResult> {
  const d = detail(reason);
  return sql.begin(async (tx) => {
    const [entry] = await tx<{ bot_id: string; slug: string }[]>`
      SELECT e.bot_id, g.slug FROM game_entries e JOIN games g ON g.id = e.game_id
      WHERE e.id = ${entryId}`;
    if (!entry) throw new Error(`There is no game entry ${entryId}.`);
    const changed = hidden
      ? await tx`
          INSERT INTO hidden_game_entries (entry_id) VALUES (${entryId})
          ON CONFLICT DO NOTHING RETURNING entry_id`
      : await tx`
          DELETE FROM hidden_game_entries WHERE entry_id = ${entryId} RETURNING entry_id`;
    if (changed.length === 0)
      return {
        changed: false,
        message: `Entry ${entryId} ${hidden ? "was already hidden" : "wasn't hidden"}.`,
      };
    await logAction(tx, {
      action: hidden ? "admin.entry.hide" : "admin.entry.unhide",
      botId: Number(entry.bot_id),
      keyId: null,
      subject: `entry:${entryId}`,
      ipHash: null,
      detail: { ...d, game: entry.slug },
    });
    return {
      changed: true,
      message: `${hidden ? "Hid" : "Unhid"} entry ${entryId} of ${entry.slug}.`,
    };
  });
}
