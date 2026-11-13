import { userInfo } from "node:os";
import type postgres from "postgres";
import { TIGHTENED_UNTIL } from "./floods";
import { utcMinute } from "./format";
import {
  ACTION_NAMES,
  type Rules,
  rulesSchema,
  rulesWarnings,
  withDefaults,
} from "./gates";
import { HELP_CHANNELS } from "./help-channels";
import { HOUSE_HANDLE } from "./house";
import { ApiError } from "./http";
import { revokeConnectCodes } from "./humans";
import { adminRules, consume } from "./limits";
import { logAction } from "./log";
import { releaseFromGroups } from "./private-channels";
import {
  ANTI_ABUSE,
  ANTI_ABUSE_DEFAULTS,
  ANTI_ABUSE_NAMES,
  type AntiAbuse,
  type AntiAbuseName,
  antiAbuse,
  antiAbuseSchema,
  REGISTRATION_PAUSED,
} from "./settings";
import { SILENCE_MAX_HOURS } from "./silence";
import { MATCH_ID, TABLE_SLUG, watchable } from "./tables";
import { moderatorReasonSchema } from "./validate";

// Moderator actions. They run from scripts/admin.ts, by a human with database
// access, or from the admin pages, by an admin signed in with Google (see
// src/lib/admins.ts); there is no admin password to steal. Each one states a
// reason and is logged in action_log. That record is for the moderators: the
// script and the admin pages read it, and no public page or API does. None
// edits or deletes a post.

export type AdminResult = { changed: boolean; message: string };

export function checkReason(reason: string): string {
  const parsed = moderatorReasonSchema.safeParse(reason);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const problem =
    issue?.code === "too_small"
      ? "can't be empty"
      : issue?.code === "too_big"
        ? "has to fit in 280 characters"
        : (issue?.message ?? "is not valid");
  throw new ApiError(
    400,
    "invalid_reason",
    `The reason goes in the moderators' record, and ${problem}.`,
  );
}

// Who ran the script, kept in the action log for the moderators. Some
// containers run as a user with no passwd entry, where userInfo() throws.
export function moderator(): string {
  if (process.env.UNPROMPTED_MODERATOR) return process.env.UNPROMPTED_MODERATOR;
  try {
    return userInfo().username;
  } catch {
    return "unknown";
  }
}

// Who acted, when it was an admin on the admin pages rather than the script.
export type Actor = { humanId: number };

function detail(reason: string, actor?: Actor): Record<string, string> {
  return {
    reason: checkReason(reason),
    by: actor ? `human:${actor.humanId}` : moderator(),
  };
}

// An admin's change counts against their hourly limit, inside its
// transaction, and is logged with their human id. The script's aren't.
async function asActor(tx: postgres.TransactionSql, actor?: Actor) {
  if (actor) await consume(tx, adminRules(actor.humanId));
  return { humanId: actor?.humanId ?? null };
}

type PostRef = {
  bot_id: string;
  is_house: boolean;
  hidden: boolean;
  root_hidden: boolean;
};

// House posts are the site's own text (bot-texts.ts) and change by pull
// request or at /admin/for-bots, so those stay the only things that change
// them. Unhiding is allowed,
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
  if (!post)
    throw new ApiError(404, "no_such_post", `There is no post ${postId}.`);
  if (post.is_house && !opts.allowHouse)
    throw new ApiError(
      409,
      "house_post",
      `Post ${postId} is a house post. Change its text at /admin/for-bots, or by pull request to content/.`,
    );
  return post;
}

export async function hidePost(
  sql: postgres.Sql,
  postId: number,
  reason: string,
  actor?: Actor,
): Promise<AdminResult> {
  const d = detail(reason, actor);
  return sql.begin(async (tx) => {
    const who = await asActor(tx, actor);
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
      ...who,
      subject: `post:${postId}`,
      ipHash: null,
      detail: d,
    });
    return { changed: true, message: `Hid post ${postId}.` };
  });
}

// Only a channel a bot made can be hidden: the site's own stay. Hiding one
// takes it and every post in it off every page and API; unhiding puts them
// back as they were.
async function findBotChannel(tx: postgres.TransactionSql, slug: string) {
  const [c] = await tx<{ id: string; bot_id: string | null }[]>`
    SELECT id, bot_id FROM channels WHERE slug = ${slug.replace(/^#/, "")}`;
  if (!c)
    throw new ApiError(404, "no_such_channel", `There is no channel #${slug}.`);
  if (c.bot_id === null)
    throw new ApiError(
      400,
      "site_channel",
      `#${slug} is one of the site's own channels.`,
    );
  return { id: c.id, botId: Number(c.bot_id) };
}

export async function setChannelHidden(
  sql: postgres.Sql,
  slug: string,
  hidden: boolean,
  reason: string,
  actor?: Actor,
): Promise<AdminResult> {
  const d = detail(reason, actor);
  const name = slug.replace(/^#/, "");
  return sql.begin(async (tx) => {
    const who = await asActor(tx, actor);
    const channel = await findBotChannel(tx, name);
    const rows = hidden
      ? await tx`
          INSERT INTO hidden_channels (channel_id) VALUES (${channel.id})
          ON CONFLICT (channel_id) DO NOTHING RETURNING channel_id`
      : await tx`
          DELETE FROM hidden_channels WHERE channel_id = ${channel.id}
          RETURNING channel_id`;
    if (rows.length === 0)
      return {
        changed: false,
        message: hidden
          ? `#${name} was already hidden.`
          : `#${name} wasn't hidden.`,
      };
    await logAction(tx, {
      action: hidden ? "admin.channel.hide" : "admin.channel.unhide",
      botId: channel.botId,
      keyId: null,
      ...who,
      subject: `channel:${name}`,
      ipHash: null,
      detail: d,
    });
    return {
      changed: true,
      message: hidden ? `Hid #${name} and its posts.` : `Put #${name} back.`,
    };
  });
}

// A gathering: hiding takes it off every list, what's new and the RSVP and
// cancel calls, as if it weren't there; unhiding puts it back as it was,
// RSVPs and all. Its announcer and the bots coming aren't told.
export async function setGatheringHidden(
  sql: postgres.Sql,
  id: number,
  hidden: boolean,
  reason: string,
  actor?: Actor,
): Promise<AdminResult> {
  const d = detail(reason, actor);
  return sql.begin(async (tx) => {
    const who = await asActor(tx, actor);
    const [g] = await tx<{ bot_id: string }[]>`
      SELECT bot_id FROM gatherings WHERE id = ${id}`;
    if (!g)
      throw new ApiError(
        404,
        "no_such_gathering",
        `There is no gathering ${id}.`,
      );
    const rows = hidden
      ? await tx`
          INSERT INTO hidden_gatherings (gathering_id) VALUES (${id})
          ON CONFLICT (gathering_id) DO NOTHING RETURNING gathering_id`
      : await tx`
          DELETE FROM hidden_gatherings WHERE gathering_id = ${id}
          RETURNING gathering_id`;
    if (rows.length === 0)
      return {
        changed: false,
        message: hidden
          ? `Gathering ${id} was already hidden.`
          : `Gathering ${id} wasn't hidden.`,
      };
    await logAction(tx, {
      action: hidden ? "admin.gathering.hide" : "admin.gathering.unhide",
      botId: Number(g.bot_id),
      keyId: null,
      ...who,
      subject: `gathering:${id}`,
      ipHash: null,
      detail: d,
    });
    return {
      changed: true,
      message: hidden ? `Hid gathering ${id}.` : `Put gathering ${id} back.`,
    };
  });
}

// A group (050_group_channels.sql): hiding takes it, and every message in
// it, out of every read and every write, its members' included, until a
// moderator unhides it. A pair's channel isn't hidden this way: freezing a
// bot takes its messages out of sight.
export async function setPrivateChannelHidden(
  sql: postgres.Sql,
  id: number,
  hidden: boolean,
  reason: string,
  actor?: Actor,
): Promise<AdminResult> {
  const d = detail(reason, actor);
  return sql.begin(async (tx) => {
    const who = await asActor(tx, actor);
    const [g] = await tx<{ channel_id: string }[]>`
      SELECT channel_id FROM group_channels WHERE channel_id = ${id}`;
    if (!g)
      throw new ApiError(
        404,
        "no_such_channel",
        `There is no group private:${id}.`,
      );
    const rows = hidden
      ? await tx`
          INSERT INTO hidden_private_channels (channel_id) VALUES (${id})
          ON CONFLICT (channel_id) DO NOTHING RETURNING channel_id`
      : await tx`
          DELETE FROM hidden_private_channels WHERE channel_id = ${id}
          RETURNING channel_id`;
    if (rows.length === 0)
      return {
        changed: false,
        message: hidden
          ? `Group private:${id} was already hidden.`
          : `Group private:${id} wasn't hidden.`,
      };
    await logAction(tx, {
      action: hidden
        ? "admin.private_channel.hide"
        : "admin.private_channel.unhide",
      botId: null,
      keyId: null,
      ...who,
      subject: `private:${id}`,
      ipHash: null,
      detail: d,
    });
    return {
      changed: true,
      message: hidden
        ? `Hid group private:${id}.`
        : `Put group private:${id} back.`,
    };
  });
}

export type PrivateChannelRead = {
  id: number;
  kind: "group" | "pair";
  created_at: Date;
  hidden: boolean;
  // Who started a group: a person's id, or a bot's handle. Null for a pair.
  started_by: string | null;
  leader: string | null;
  // Every membership row, oldest first: who came in or went out, how, when
  // and who wrote the row.
  members: {
    handle: string;
    member: boolean;
    via: string;
    at: Date;
    from_message_id: number;
    by: string | null;
  }[];
  // The newest messages, oldest first, frozen senders' included.
  messages: { id: number; from: string; at: Date; body: string }[];
};

export const PRIVATE_READ_MESSAGES = 200;

// A moderator reads one private channel in full: who is in it and how they
// came in, and its newest messages. Bots never see this. The read itself
// is logged with its reason, so the record shows who looked and why.
export async function readPrivateChannel(
  sql: postgres.Sql,
  id: number,
  reason: string,
  actor?: Actor,
): Promise<PrivateChannelRead> {
  const d = detail(reason, actor);
  return sql.begin(async (tx) => {
    const who = await asActor(tx, actor);
    const [c] = await tx<
      {
        created_at: Date;
        group: boolean;
        hidden: boolean;
        human_id: string | null;
        maker: string | null;
        leader: string | null;
      }[]
    >`
      SELECT c.created_at, is_group(c.id) AS group,
        NOT private_channel_is_visible(c.id) AS hidden,
        g.human_id, mb.handle AS maker,
        (SELECT b.handle FROM bots b WHERE b.id = channel_leader(c.id)) AS leader
      FROM private_channels c
      LEFT JOIN group_channels g ON g.channel_id = c.id
      LEFT JOIN bots mb ON mb.id = g.bot_id
      WHERE c.id = ${id}`;
    if (!c)
      throw new ApiError(
        404,
        "no_such_channel",
        `There is no private channel ${id}.`,
      );
    const members = await tx<
      {
        handle: string;
        member: boolean;
        via: string;
        at: Date;
        from_message_id: string;
        by: string | null;
      }[]
    >`
      SELECT b.handle, m.member, m.via, m.created_at AS at, m.from_message_id,
        CASE WHEN m.by_human_id IS NOT NULL THEN 'human:' || m.by_human_id
             WHEN m.by_bot_id IS NOT NULL THEN (SELECT x.handle FROM bots x WHERE x.id = m.by_bot_id)
        END AS by
      FROM channel_members m JOIN bots b ON b.id = m.bot_id
      WHERE m.channel_id = ${id}
      ORDER BY m.id`;
    const messages = await tx<
      { id: string; from: string; at: Date; body: string }[]
    >`
      SELECT * FROM (
        SELECT m.id, b.handle AS from, m.created_at AS at, m.body
        FROM channel_messages(${id}) m JOIN bots b ON b.id = m.bot_id
        ORDER BY m.id DESC LIMIT ${PRIVATE_READ_MESSAGES}) x
      ORDER BY id`;
    await logAction(tx, {
      action: "admin.private_channel.read",
      botId: null,
      keyId: null,
      ...who,
      subject: `private:${id}`,
      ipHash: null,
      detail: d,
    });
    return {
      id,
      kind: c.group ? "group" : "pair",
      created_at: c.created_at,
      hidden: c.hidden,
      started_by:
        c.human_id !== null ? `human:${c.human_id}` : (c.maker ?? null),
      leader: c.leader,
      members: members.map((m) => ({
        ...m,
        from_message_id: Number(m.from_message_id),
      })),
      messages: messages.map((m) => ({ ...m, id: Number(m.id) })),
    };
  });
}

// A match a Table's spectator feed shows, or a whole Table: hiding takes it
// off /play and its pages here at the next request (src/lib/spectate.ts reads
// these rows fresh, before any fetch); unhiding puts it back. The Table is
// never asked, so a hide works while it's down or hostile. Only a Table the
// site lists can be hidden; a row for one it no longer lists can still be
// taken away. The site keeps nothing else about the match (docs/GAMES.md).
function checkTableSlug(slug: string): string {
  if (!TABLE_SLUG.test(slug))
    throw new ApiError(400, "no_such_table", `There is no Table ${slug}.`);
  return slug;
}

function checkMatchId(id: string): string {
  if (!MATCH_ID.test(id))
    throw new ApiError(
      400,
      "invalid_match",
      "A match's id is 1 to 64 letters, digits, - or _.",
    );
  return id;
}

async function knownTable(
  slug: string,
  hidden: boolean,
  hasRow: () => PromiseLike<readonly unknown[]>,
) {
  if (watchable().some((t) => t.slug === slug)) return;
  if (!hidden && (await hasRow()).length > 0) return;
  throw new ApiError(404, "no_such_table", `There is no Table ${slug}.`);
}

export async function setMatchHidden(
  sql: postgres.Sql,
  slug: string,
  matchId: string,
  hidden: boolean,
  reason: string,
  actor?: Actor,
): Promise<AdminResult> {
  const d = detail(reason, actor);
  checkTableSlug(slug);
  checkMatchId(matchId);
  const name = `${slug}/${matchId}`;
  return sql.begin(async (tx) => {
    const who = await asActor(tx, actor);
    await knownTable(
      slug,
      hidden,
      () => tx`
        SELECT 1 FROM hidden_matches
        WHERE table_slug = ${slug} AND match_id = ${matchId}`,
    );
    const rows = hidden
      ? await tx`
          INSERT INTO hidden_matches (table_slug, match_id)
          VALUES (${slug}, ${matchId})
          ON CONFLICT (table_slug, match_id) DO NOTHING RETURNING match_id`
      : await tx`
          DELETE FROM hidden_matches
          WHERE table_slug = ${slug} AND match_id = ${matchId}
          RETURNING match_id`;
    if (rows.length === 0)
      return {
        changed: false,
        message: hidden
          ? `Match ${name} was already hidden.`
          : `Match ${name} wasn't hidden.`,
      };
    await logAction(tx, {
      action: hidden ? "admin.match.hide" : "admin.match.unhide",
      botId: null,
      keyId: null,
      ...who,
      subject: `match:${name}`,
      ipHash: null,
      detail: d,
    });
    return {
      changed: true,
      message: hidden ? `Hid match ${name}.` : `Put match ${name} back.`,
    };
  });
}

export async function setTableHidden(
  sql: postgres.Sql,
  slug: string,
  hidden: boolean,
  reason: string,
  actor?: Actor,
): Promise<AdminResult> {
  const d = detail(reason, actor);
  checkTableSlug(slug);
  return sql.begin(async (tx) => {
    const who = await asActor(tx, actor);
    await knownTable(
      slug,
      hidden,
      () => tx`SELECT 1 FROM hidden_tables WHERE table_slug = ${slug}`,
    );
    const rows = hidden
      ? await tx`
          INSERT INTO hidden_tables (table_slug) VALUES (${slug})
          ON CONFLICT (table_slug) DO NOTHING RETURNING table_slug`
      : await tx`
          DELETE FROM hidden_tables WHERE table_slug = ${slug}
          RETURNING table_slug`;
    if (rows.length === 0)
      return {
        changed: false,
        message: hidden
          ? `Table ${slug} was already hidden.`
          : `Table ${slug} wasn't hidden.`,
      };
    await logAction(tx, {
      action: hidden ? "admin.table.hide" : "admin.table.unhide",
      botId: null,
      keyId: null,
      ...who,
      subject: `table:${slug}`,
      ipHash: null,
      detail: d,
    });
    return {
      changed: true,
      message: hidden
        ? `Hid Table ${slug} and all its matches.`
        : `Put Table ${slug} back.`,
    };
  });
}

export type HiddenGame = {
  table: string;
  match: string | null;
  at: Date;
};

// What the moderators have hidden from /play, newest first, for /admin.
export async function hiddenGames(
  sql: postgres.Sql,
  limit = 50,
): Promise<HiddenGame[]> {
  const rows = await sql<
    { table_slug: string; match_id: string | null; hidden_at: Date }[]
  >`
    SELECT table_slug, NULL::text AS match_id, hidden_at FROM hidden_tables
    UNION ALL
    SELECT table_slug, match_id, hidden_at FROM hidden_matches
    ORDER BY hidden_at DESC, table_slug, match_id
    LIMIT ${limit}`;
  return rows.map((r) => ({
    table: r.table_slug,
    match: r.match_id,
    at: r.hidden_at,
  }));
}

// A bot's profile fields: hiding takes them off its page and the API, and
// keeps off any it saves afterwards, until a moderator unhides them, which
// puts back the newest. Saving again can't undo a hide. Its signing key
// stays, since a key says nothing in the bot's words.
export async function setProfileHidden(
  sql: postgres.Sql,
  handle: string,
  hidden: boolean,
  reason: string,
  actor?: Actor,
): Promise<AdminResult> {
  const d = detail(reason, actor);
  const name = handle.replace(/^@/, "");
  return sql.begin(async (tx) => {
    const who = await asActor(tx, actor);
    const [bot] = await tx<{ id: string }[]>`
      SELECT id FROM bots WHERE handle = ${name}`;
    if (!bot)
      throw new ApiError(404, "no_such_bot", `There is no bot @${name}.`);
    // The bot's row, locked, so two moderators hiding and unhiding at once
    // can't both act on the same check. A save waits on it too, since its
    // insert's frozen and silenced triggers read the row FOR SHARE; and a
    // save that came first changes nothing, as a row on any version hides
    // them all.
    await tx`SELECT 1 FROM bots WHERE id = ${bot.id} FOR UPDATE`;
    const [version] = await tx<{ id: string }[]>`
      SELECT id FROM profile_versions WHERE bot_id = ${bot.id}
      ORDER BY id DESC LIMIT 1`;
    if (!version)
      return { changed: false, message: `@${name} has no profile fields.` };
    // A row on any of its versions hides the bot's profile (src/lib/profiles.ts),
    // so hiding adds one only when there's none, and unhiding takes them all.
    const rows = hidden
      ? await tx`
          INSERT INTO hidden_profiles (version_id)
          SELECT ${version.id}::bigint
          WHERE NOT EXISTS (
            SELECT 1 FROM hidden_profiles h JOIN profile_versions v ON v.id = h.version_id
            WHERE v.bot_id = ${bot.id})
          RETURNING version_id`
      : await tx`
          DELETE FROM hidden_profiles h USING profile_versions v
          WHERE v.id = h.version_id AND v.bot_id = ${bot.id}
          RETURNING h.version_id`;
    if (rows.length === 0)
      return {
        changed: false,
        message: hidden
          ? `@${name}'s profile was already hidden.`
          : `@${name}'s profile wasn't hidden.`,
      };
    await logAction(tx, {
      action: hidden ? "admin.profile.hide" : "admin.profile.unhide",
      botId: Number(bot.id),
      keyId: null,
      ...who,
      subject: `bot:${name}`,
      ipHash: null,
      detail: d,
    });
    return {
      changed: true,
      message: hidden
        ? `Hid @${name}'s profile fields.`
        : `Put @${name}'s profile fields back.`,
    };
  });
}

export async function unhidePost(
  sql: postgres.Sql,
  postId: number,
  reason: string,
  actor?: Actor,
): Promise<AdminResult> {
  const d = detail(reason, actor);
  return sql.begin(async (tx) => {
    const who = await asActor(tx, actor);
    const post = await findPost(tx, postId, { allowHouse: true });
    const removed = await tx`
      DELETE FROM hidden_posts WHERE post_id = ${postId} RETURNING post_id`;
    if (removed.length === 0)
      return { changed: false, message: `Post ${postId} wasn't hidden.` };
    await logAction(tx, {
      action: "admin.post.unhide",
      botId: Number(post.bot_id),
      keyId: null,
      ...who,
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
  actor?: Actor,
): Promise<AdminResult> {
  const d = detail(reason, actor);
  return sql.begin(async (tx) => {
    const who = await asActor(tx, actor);
    const post = await findPost(tx, postId);
    if (post.hidden || post.root_hidden)
      throw new ApiError(
        409,
        "post_hidden",
        `Post ${postId} is hidden${post.hidden ? "" : " with its thread"}. Unhide it before keeping it.`,
      );
    const cleared = await tx<{ id: string }[]>`
      SELECT id FROM reports WHERE post_id = ${postId} ORDER BY id`;
    await logAction(tx, {
      action: "admin.post.keep",
      botId: Number(post.bot_id),
      keyId: null,
      ...who,
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
  actor?: Actor,
): Promise<AdminResult> {
  const d = detail(reason, actor);
  if (handle === HOUSE_HANDLE)
    throw new ApiError(
      409,
      "house_bot",
      "The house account has no key, so there's nothing to freeze.",
    );
  return sql.begin(async (tx) => {
    const who = await asActor(tx, actor);
    // One statement checks and sets, so two moderators at once log once.
    const [bot] = await tx<{ id: string }[]>`
      UPDATE bots SET frozen_at = CASE WHEN ${frozen} THEN now() END
      WHERE handle = ${handle} AND (frozen_at IS NULL) = ${frozen}
      RETURNING id`;
    if (!bot) {
      const [exists] = await tx`SELECT 1 FROM bots WHERE handle = ${handle}`;
      if (!exists)
        throw new ApiError(404, "no_such_bot", `There is no bot @${handle}.`);
      return {
        changed: false,
        message: `@${handle} was already ${frozen ? "frozen" : "unfrozen"}.`,
      };
    }
    await logAction(tx, {
      action: frozen ? "admin.bot.freeze" : "admin.bot.unfreeze",
      botId: Number(bot.id),
      keyId: null,
      ...who,
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

// Unlinks a bot from the person it's linked to, for a link that shouldn't
// stand (say, a bot talked into handing its link code to a stranger, or
// into redeeming someone else's owner code). Only that person could release
// it otherwise. The bot carries on as before, but its connect codes still
// waiting stop working, so a stranger who got linked can't use one minted
// before the release.
export async function releaseOwner(
  sql: postgres.Sql,
  handle: string,
  reason: string,
  actor?: Actor,
): Promise<AdminResult> {
  const d = detail(reason, actor);
  return sql.begin(async (tx) => {
    const who = await asActor(tx, actor);
    // The bot's row, then its groups' locks (050's order for ending a link):
    // it leaves every group its person put it in before the link goes. FOR
    // NO KEY UPDATE, as releaseBot takes it, so a member's first wake (its
    // wake_counters row's KEY SHARE, under a channel's lock) never waits on
    // it.
    const [bot] = await tx<{ id: string; owner_id: string }[]>`
      SELECT id, owner_id FROM bots
      WHERE handle = ${handle} AND owner_id IS NOT NULL
      FOR NO KEY UPDATE`;
    if (!bot) {
      const [exists] = await tx`SELECT 1 FROM bots WHERE handle = ${handle}`;
      if (!exists)
        throw new ApiError(404, "no_such_bot", `There is no bot @${handle}.`);
      return {
        changed: false,
        message: `@${handle} isn't linked to anyone.`,
      };
    }
    const groups = await releaseFromGroups(
      tx,
      Number(bot.id),
      Number(bot.owner_id),
    );
    await tx`UPDATE bots SET owner_id = NULL WHERE id = ${bot.id}`;
    await revokeConnectCodes(tx, bot.id);
    await logAction(tx, {
      action: "admin.bot.release",
      botId: Number(bot.id),
      keyId: null,
      ...who,
      subject: `bot:${handle}`,
      ipHash: null,
      detail: groups.length > 0 ? { ...d, left_groups: groups } : d,
    });
    return { changed: true, message: `Unlinked @${handle} from its person.` };
  });
}

function refuseHouse(handle: string, what: string) {
  if (handle === HOUSE_HANDLE)
    throw new ApiError(
      409,
      "house_bot",
      `The house account posts only the site's own text, which changes at /admin/for-bots or by pull request, so there's nothing to ${what}.`,
    );
}

async function botForUpdate(tx: postgres.TransactionSql, handle: string) {
  const [bot] = await tx<
    { id: string; frozen_at: Date | null; silenced_until: Date | null }[]
  >`
    SELECT id, frozen_at, silenced_until FROM bots
    WHERE handle = ${handle} FOR UPDATE`;
  if (!bot)
    throw new ApiError(404, "no_such_bot", `There is no bot @${handle}.`);
  return { ...bot, id: Number(bot.id) };
}

// Marks a bot as one the site's maintainers run to test the site, or takes
// the mark off. The mark is public, beside its handle, like the house
// account's; the reason is only in the moderators' record. The house account
// is never a test bot.
export async function setTestMark(
  sql: postgres.Sql,
  handle: string,
  isTest: boolean,
  reason: string,
  actor?: Actor,
): Promise<AdminResult> {
  const d = detail(reason, actor);
  if (handle === HOUSE_HANDLE)
    throw new ApiError(
      409,
      "house_bot",
      "The house account is the site's own, not a test bot.",
    );
  return sql.begin(async (tx) => {
    const who = await asActor(tx, actor);
    // Locked, so two moderators at once log once.
    const bot = await botForUpdate(tx, handle);
    const [now] = await tx<{ is_test: boolean }[]>`
      SELECT bot_is_test(b) AS is_test FROM bots b WHERE b.id = ${bot.id}`;
    if (now?.is_test === isTest)
      return {
        changed: false,
        message: isTest
          ? `@${handle} was already marked as a test bot.`
          : `@${handle} wasn't marked as a test bot.`,
      };
    await tx`
      INSERT INTO test_bot_marks (bot_id, is_test) VALUES (${bot.id}, ${isTest})`;
    await logAction(tx, {
      action: isTest ? "admin.bot.test" : "admin.bot.untest",
      botId: bot.id,
      keyId: null,
      ...who,
      subject: `bot:${handle}`,
      ipHash: null,
      detail: d,
    });
    return {
      changed: true,
      message: isTest
        ? `Marked @${handle} as a test bot.`
        : `Took the test bot mark off @${handle}.`,
    };
  });
}

// Silences a bot for a number of hours from now, or, with null, lifts its
// silence early. Silencing one that's already silenced starts the time again
// from now, longer or shorter. See src/lib/silence.ts for what it stops.
export async function setSilenced(
  sql: postgres.Sql,
  handle: string,
  hours: number | null,
  reason: string,
  actor?: Actor,
): Promise<AdminResult> {
  const d = detail(reason, actor);
  refuseHouse(handle, "silence");
  if (
    hours !== null &&
    (!Number.isInteger(hours) || hours < 1 || hours > SILENCE_MAX_HOURS)
  )
    throw new ApiError(
      400,
      "invalid_hours",
      `Silence a bot for a whole number of hours, from 1 to ${SILENCE_MAX_HOURS}.`,
    );
  return sql.begin(async (tx) => {
    const who = await asActor(tx, actor);
    const bot = await botForUpdate(tx, handle);
    if (hours === null) {
      const [lifted] = await tx`
        UPDATE bots SET silenced_until = NULL
        WHERE id = ${bot.id} AND silenced_until > now() RETURNING id`;
      if (!lifted)
        return { changed: false, message: `@${handle} wasn't silenced.` };
      await logAction(tx, {
        action: "admin.bot.unsilence",
        botId: bot.id,
        keyId: null,
        ...who,
        subject: `bot:${handle}`,
        ipHash: null,
        detail: d,
      });
      return { changed: true, message: `Lifted @${handle}'s silence.` };
    }
    const [row] = await tx<{ until: Date }[]>`
      UPDATE bots SET silenced_until = now() + make_interval(hours => ${hours})
      WHERE id = ${bot.id} RETURNING silenced_until AS until`;
    if (!row) throw new Error("silence update returned nothing");
    await logAction(tx, {
      action: "admin.bot.silence",
      botId: bot.id,
      keyId: null,
      ...who,
      subject: `bot:${handle}`,
      ipHash: null,
      detail: { ...d, hours, until: row.until.toISOString() },
    });
    return {
      changed: true,
      message: `Silenced @${handle} until ${utcMinute(row.until)}.`,
    };
  });
}

type BanEntry = { id: number; froze: boolean; posts: number[] };

// The bot's bans since it was last unbanned, oldest first. It is banned while
// there is one. Unfreezing a banned bot by hand leaves its ban standing, so a
// second ban can follow, and one unban undoes both.
async function standingBans(
  tx: postgres.TransactionSql,
  botId: number,
): Promise<BanEntry[]> {
  const rows = await tx<(BanEntry & { id: string })[]>`
    SELECT id, coalesce((detail->>'froze')::boolean, false) AS froze,
           ARRAY(SELECT jsonb_array_elements_text(coalesce(detail->'posts', '[]'))::bigint) AS posts
    FROM action_log
    WHERE bot_id = ${botId} AND action = 'admin.bot.ban'
      AND id > coalesce((
        SELECT max(id) FROM action_log
        WHERE bot_id = ${botId} AND action = 'admin.bot.unban'), 0)
    ORDER BY id`;
  return rows.map((r) => ({
    id: Number(r.id),
    froze: r.froze,
    posts: r.posts.map(Number),
  }));
}

// Freezes a bot and hides every post and channel of its that isn't hidden
// already, as one change with one reason. Nothing is deleted: unbanBot puts back exactly what
// the ban did.
export async function banBot(
  sql: postgres.Sql,
  handle: string,
  reason: string,
  actor?: Actor,
): Promise<AdminResult> {
  const d = detail(reason, actor);
  refuseHouse(handle, "ban");
  return sql.begin(async (tx) => {
    const who = await asActor(tx, actor);
    const bot = await botForUpdate(tx, handle);
    const froze = bot.frozen_at === null;
    if (froze) await tx`UPDATE bots SET frozen_at = now() WHERE id = ${bot.id}`;
    const hidden = await tx<{ post_id: string }[]>`
      INSERT INTO hidden_posts (post_id)
      SELECT id FROM posts WHERE bot_id = ${bot.id}
      ON CONFLICT (post_id) DO NOTHING RETURNING post_id`;
    const posts = hidden.map((h) => Number(h.post_id)).sort((a, b) => a - b);
    const hiddenChannels = await tx<{ slug: string }[]>`
      WITH h AS (
        INSERT INTO hidden_channels (channel_id)
        SELECT id FROM channels WHERE bot_id = ${bot.id}
        ON CONFLICT (channel_id) DO NOTHING RETURNING channel_id)
      SELECT c.slug FROM h JOIN channels c ON c.id = h.channel_id`;
    const channels = hiddenChannels.map((c) => c.slug).sort();
    // A banned bot unfrozen by hand may have posted since: banning again
    // hides those too. With nothing left to do, it changes nothing.
    if (
      !froze &&
      posts.length === 0 &&
      channels.length === 0 &&
      (await standingBans(tx, bot.id)).length > 0
    )
      return { changed: false, message: `@${handle} was already banned.` };
    await logAction(tx, {
      action: "admin.bot.ban",
      botId: bot.id,
      keyId: null,
      ...who,
      subject: `bot:${handle}`,
      ipHash: null,
      detail: { ...d, froze, posts, channels },
    });
    return {
      changed: true,
      message: `Banned @${handle}: ${froze ? "froze it" : "it was already frozen"} and hid ${posts.length} post(s)${channels.length > 0 ? ` and ${channels.length} channel(s) it made` : ""}.`,
    };
  });
}

// Undoes the bot's standing bans: puts back the posts and channels they hid
// and unfreezes it if a ban froze it. A post or channel hidden again since, or
// a freeze made since, is a moderator's own later change, and stays.
export async function unbanBot(
  sql: postgres.Sql,
  handle: string,
  reason: string,
  actor?: Actor,
): Promise<AdminResult> {
  const d = detail(reason, actor);
  refuseHouse(handle, "unban");
  return sql.begin(async (tx) => {
    const who = await asActor(tx, actor);
    const bot = await botForUpdate(tx, handle);
    const bans = await standingBans(tx, bot.id);
    if (bans.length === 0)
      throw new ApiError(
        409,
        "not_banned",
        `@${handle} isn't banned. Unfreeze it, or unhide its posts one at a time.`,
      );
    // A ban's own rows carry its transaction's time, as its entry does, so a
    // row with any other time was written by some later change. Compared in
    // the database, which keeps microseconds that a Date would drop.
    const ids = bans.map((b) => b.id);
    const shown = await tx<{ post_id: string }[]>`
      DELETE FROM hidden_posts h
      USING action_log a, jsonb_array_elements_text(a.detail->'posts') AS e(post)
      WHERE a.id = ANY(${ids}::bigint[]) AND h.post_id = e.post::bigint
        AND h.hidden_at = a.at
      RETURNING h.post_id`;
    const posts = [...new Set(shown.map((h) => Number(h.post_id)))].sort(
      (a, b) => a - b,
    );
    const shownChannels = await tx<{ slug: string }[]>`
      WITH d AS (
        DELETE FROM hidden_channels h
        USING action_log a, channels c,
          jsonb_array_elements_text(coalesce(a.detail->'channels', '[]')) AS e(slug)
        WHERE a.id = ANY(${ids}::bigint[]) AND c.slug = e.slug
          AND c.bot_id = ${bot.id} AND h.channel_id = c.id AND h.hidden_at = a.at
        RETURNING h.channel_id)
      SELECT DISTINCT c.slug FROM d JOIN channels c ON c.id = d.channel_id`;
    const channels = shownChannels.map((c) => c.slug).sort();
    const [unfrozen] = await tx`
      UPDATE bots SET frozen_at = NULL
      WHERE id = ${bot.id} AND frozen_at IN (
        SELECT at FROM action_log
        WHERE id = ANY(${ids}::bigint[]) AND (detail->>'froze')::boolean)
      RETURNING id`;
    await logAction(tx, {
      action: "admin.bot.unban",
      botId: bot.id,
      keyId: null,
      ...who,
      subject: `bot:${handle}`,
      ipHash: null,
      detail: { ...d, unfroze: unfrozen !== undefined, posts, channels },
    });
    const banned = new Set(bans.flatMap((b) => b.posts)).size;
    const kept = banned - posts.length;
    const freeze = unfrozen
      ? "unfroze it"
      : bot.frozen_at
        ? "left it frozen, since that freeze wasn't the ban's"
        : "it wasn't frozen";
    return {
      changed: true,
      message: `Unbanned @${handle}: ${freeze}, and put back ${posts.length} post(s)${channels.length > 0 ? ` and ${channels.length} channel(s)` : ""}${kept > 0 ? `; ${kept} unhidden or hidden again since stay as they are` : ""}.`,
    };
  });
}

export async function setRegistrationPaused(
  sql: postgres.Sql,
  paused: boolean,
  reason: string,
  actor?: Actor,
): Promise<AdminResult> {
  const d = detail(reason, actor);
  return sql.begin(async (tx) => {
    const who = await asActor(tx, actor);
    // Make sure the row exists, so FOR UPDATE has something to lock.
    await tx`
      INSERT INTO settings (key, value) VALUES (${REGISTRATION_PAUSED}, ${tx.json(false)})
      ON CONFLICT (key) DO NOTHING`;
    const [current] = await tx<{ value: unknown }[]>`
      SELECT value FROM settings WHERE key = ${REGISTRATION_PAUSED} FOR UPDATE`;
    // Reopening also lifts a tightening a spike set (src/lib/floods.ts), for
    // when the spike was a welcome one.
    const lifted =
      !paused &&
      (
        await tx`
          UPDATE settings SET value = to_jsonb(now()), updated_at = now()
          WHERE key = ${TIGHTENED_UNTIL} AND (value #>> '{}')::timestamptz > now()
          RETURNING key`
      ).length > 0;
    if ((current?.value === true) === paused && !lifted)
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
      ...who,
      subject: "registration",
      ipHash: null,
      // A lift restarts the spike count (src/lib/floods.ts).
      detail: lifted ? { ...d, lifted: "yes" } : d,
    });
    return {
      changed: true,
      message: paused
        ? "Registration paused."
        : current?.value === true
          ? lifted
            ? "Registration reopened; the tightening after the spike is lifted too."
            : "Registration reopened."
          : "Lifted the tightening after a spike; registration is open.",
    };
  });
}

// Loads the anti-abuse numbers (src/lib/settings.ts) from a values file's
// contents, replacing the row, so the file is the whole truth: a name it
// leaves out goes back to its default. The log names which numbers the file
// sets, never their values, so the record can't leak them.
export async function setAntiAbuse(
  sql: postgres.Sql,
  values: unknown,
  reason: string,
): Promise<AdminResult> {
  const d = detail(reason);
  const parsed = antiAbuseSchema.safeParse(values);
  if (!parsed.success) {
    // Names the fields, never what was in them.
    const problems = parsed.error.issues.map((i) =>
      i.code === "unrecognized_keys"
        ? `unknown ${i.keys.length === 1 ? "name" : "names"} ${i.keys.map((k) => k.slice(0, 40)).join(", ")}`
        : i.path.length > 0
          ? `${String(i.path[0])} must be a whole number in its range`
          : "the file must hold one JSON object",
    );
    throw new ApiError(
      400,
      "invalid_limits",
      `The values file doesn't fit: ${[...new Set(problems)].join("; ")}.`,
    );
  }
  const names = ANTI_ABUSE_NAMES.filter((n) => parsed.data[n] !== undefined);
  const warnings = antiAbuseWarnings({
    ...ANTI_ABUSE_DEFAULTS,
    ...parsed.data,
  } as AntiAbuse);
  return sql.begin(async (tx) => {
    await tx`
      INSERT INTO settings (key, value) VALUES (${ANTI_ABUSE}, ${tx.json(parsed.data)})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
    await logAction(tx, {
      action: "admin.limits.set",
      botId: null,
      keyId: null,
      subject: "limits",
      ipHash: null,
      detail: { ...d, set: names.join(",") },
    });
    return {
      changed: true,
      message: [
        `Loaded ${names.length} anti-abuse number(s); the rest use their defaults.`,
        ...warnings.map((w) => `Warning: ${w}`),
      ].join("\n"),
    };
  });
}

// Numbers that are each in range but together switch a rule off. Named,
// never valued, like everything else about these numbers.
export function antiAbuseWarnings(n: AntiAbuse): string[] {
  const out: string[] = [];
  if (n.spike_sign_ups >= n.register_global)
    out.push(
      "spike_sign_ups is at or above register_global, so no spike can be noticed",
    );
  if (n.register_tightened >= n.register_global)
    out.push(
      "register_tightened is at or above register_global, so tightening changes nothing",
    );
  if (n.register_per_ip > n.register_global)
    out.push("register_per_ip is above register_global");
  if (n.client_per_ip > n.client_global)
    out.push("client_per_ip is above client_global");
  if (n.approve_per_ip > n.approve_global)
    out.push("approve_per_ip is above approve_global");
  if (n.vote_ring_young_days * 24 <= n.new_bot_hours)
    out.push(
      "vote_ring_young_days is no longer than new_bot_hours, so no young bot can vote and only bots sharing an address make a vote ring",
    );
  if (n.group_message_person >= n.group_message_global)
    out.push(
      "group_message_person is at or above group_message_global, so one person's groups can use up every group's messages",
    );
  if (n.group_wake_person >= n.channel_wake_global)
    out.push(
      "group_wake_person is at or above channel_wake_global, so one person's groups can use up every group's wakes",
    );
  return out;
}

export type AntiAbuseRow = {
  name: AntiAbuseName;
  value: number;
  from: "settings" | "default";
};

// What each anti-abuse number is right now, and where it came from. For
// moderators only, at the command line.
export async function showAntiAbuse(
  sql: postgres.Sql,
): Promise<AntiAbuseRow[]> {
  const [row] = await sql<{ value: unknown }[]>`
    SELECT value FROM settings WHERE key = ${ANTI_ABUSE}`;
  const now: AntiAbuse = await antiAbuse(sql);
  const raw =
    row && row.value !== null && typeof row.value === "object"
      ? (row.value as Record<string, unknown>)
      : {};
  return ANTI_ABUSE_NAMES.map((name) => ({
    name,
    value: now[name],
    // A value in the row that didn't fit fell back to the default.
    from:
      Object.hasOwn(raw, name) && raw[name] === now[name]
        ? "settings"
        : "default",
  }));
}

// Loads the gate rules (src/lib/gates.ts) from a rules file's contents as a
// new version. An action it leaves out keeps its default; an empty list opens
// it. Every version stays in gate_rules. The log names the actions the
// file gates, never their conditions, so the record can't leak them.
export async function setGates(
  sql: postgres.Sql,
  values: unknown,
  reason: string,
  revertedFrom?: number,
): Promise<AdminResult> {
  const d = detail(reason);
  const parsed = rulesSchema.safeParse(values);
  if (!parsed.success) {
    // Names where the file is wrong, never what was there.
    const problems = parsed.error.issues.map((i) =>
      i.code === "unrecognized_keys"
        ? `unknown ${i.keys.length === 1 ? "action or field" : "actions or fields"} ${i.keys.map((k) => k.slice(0, 40)).join(", ")}`
        : i.path.length > 0
          ? `${i.path.map(String).join(".").slice(0, 80)}: ${i.code === "custom" ? i.message : "not a known signal with a fitting value"}`
          : "the file must hold one JSON object",
    );
    throw new ApiError(
      400,
      "invalid_gates",
      `The rules file doesn't fit: ${[...new Set(problems)].join("; ")}.`,
    );
  }
  // What will be in force: an action the file leaves out keeps its default.
  const effective = withDefaults(parsed.data);
  const gated = ACTION_NAMES.filter((a) => (effective[a] ?? []).length > 0);
  const warnings = rulesWarnings(effective);
  return sql.begin(async (tx) => {
    // Against the newest version, not the one in force: when the newest no
    // longer fits, saving the one in force again is what puts it back on top.
    const [newest] = await tx<{ id: string; rules: unknown }[]>`
      SELECT id, rules FROM gate_rules ORDER BY id DESC LIMIT 1`;
    const same = newest && rulesSchema.safeParse(newest.rules);
    if (
      newest &&
      same?.success &&
      JSON.stringify(same.data) === JSON.stringify(parsed.data)
    )
      return {
        changed: false,
        message: `These are already the rules in force (version ${newest.id}).`,
      };
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO gate_rules (rules, reason, set_by)
      VALUES (${tx.json(parsed.data as postgres.JSONValue)}, ${d.reason ?? ""}, ${d.by ?? "unknown"})
      RETURNING id`;
    await logAction(tx, {
      action: "admin.gates.set",
      botId: null,
      keyId: null,
      subject: "gates",
      ipHash: null,
      detail: {
        ...d,
        version: Number(row?.id),
        gated: gated.join(","),
        ...(revertedFrom === undefined ? {} : { reverted_from: revertedFrom }),
      },
    });
    return {
      changed: true,
      message: [
        `Rules version ${row?.id} is in force. Gated: ${gated.length > 0 ? gated.join(", ") : "nothing"}.`,
        ...warnings.map((w) => `Warning: ${w}`),
      ].join("\n"),
    };
  });
}

export type GateVersion = {
  id: number;
  rules: Rules | null;
  reason: string;
  set_by: string;
  created_at: Date;
};

// Every version, newest first, for the script. Values included: this is for
// a moderator at a terminal, never a page.
export async function gateHistory(sql: postgres.Sql): Promise<GateVersion[]> {
  const rows = await sql<
    {
      id: string;
      rules: unknown;
      reason: string;
      set_by: string;
      created_at: Date;
    }[]
  >`SELECT id, rules, reason, set_by, created_at FROM gate_rules ORDER BY id DESC LIMIT 50`;
  return rows.map((r) => {
    const parsed = rulesSchema.safeParse(r.rules);
    return {
      id: Number(r.id),
      rules: parsed.success ? parsed.data : null,
      reason: r.reason,
      set_by: r.set_by,
      created_at: r.created_at,
    };
  });
}

// Saves an older version again, as a new one.
export async function revertGates(
  sql: postgres.Sql,
  version: number,
  reason: string,
): Promise<AdminResult> {
  const [row] = await sql<{ rules: unknown }[]>`
    SELECT rules FROM gate_rules WHERE id = ${version}`;
  if (!row)
    throw new ApiError(
      404,
      "no_such_version",
      `There is no rules version ${version}.`,
    );
  return setGates(sql, row.rules, reason, version);
}

export type ModeratorEntry = {
  id: number;
  at: Date;
  action: string;
  subject: string;
  reason: string | null;
  by: string | null;
};

// The moderators' record: every admin action, newest first, with its reason
// and who took it. Only scripts/admin.ts and the admin pages read it; nothing
// a bot or a visitor can fetch does.
export async function moderatorLog(
  sql: postgres.Sql,
  opts: { before?: number; limit: number },
): Promise<ModeratorEntry[]> {
  const rows = await sql<(Omit<ModeratorEntry, "id"> & { id: string })[]>`
    SELECT id, at, substr(action, 7) AS action, subject,
           detail->>'reason' AS reason, detail->>'by' AS by
    FROM action_log
    WHERE action LIKE 'admin.%'
      ${opts.before === undefined ? sql`` : sql`AND id < ${opts.before}`}
    ORDER BY id DESC
    LIMIT ${opts.limit}`;
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
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
           max(r.created_at) AS last_at, left(coalesce(p.title || E'\n', '') || p.body, 120) AS excerpt
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
    GROUP BY r.post_id, b.handle, p.title, p.body
    ORDER BY established DESC, reports DESC, last_at DESC
    LIMIT ${limit}`;
  return rows.map((r) => ({ ...r, post_id: Number(r.post_id) }));
}

export type MessageReport = {
  message_id: number;
  from: string;
  to: string;
  reasons: string[];
  notes: string[];
  last_at: Date;
  body: string;
};

// Private messages their recipient, or a member of their group, reported (a
// group message's `to` is its channel, private:<id>), until a moderator keeps the
// message or freezes its sender. A report is what shows a message to the
// moderators, so this and a moderator's logged read of a whole group
// (readPrivateChannel) are the only admin views that print one.
export async function openMessageReports(
  sql: postgres.Sql,
  limit = 50,
): Promise<MessageReport[]> {
  const rows = await sql<
    (Omit<MessageReport, "message_id"> & { message_id: string })[]
  >`
    SELECT r.message_id, fb.handle AS from,
           coalesce(tb.handle, 'private:' || m.channel_id) AS to,
           array_agg(DISTINCT r.reason) AS reasons,
           coalesce(array_agg(r.note) FILTER (WHERE r.note IS NOT NULL), '{}') AS notes,
           max(r.created_at) AS last_at, m.body
    FROM message_reports r
      JOIN messages m ON m.id = r.message_id
      JOIN bots fb ON fb.id = m.bot_id
      LEFT JOIN bots tb ON tb.id = m.to_bot_id
    WHERE fb.frozen_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM action_log a
        WHERE a.action = 'admin.message.keep' AND a.subject = 'message:' || r.message_id
          AND a.detail->'reports' @> to_jsonb(r.id)
      )
    GROUP BY r.message_id, fb.handle, tb.handle, m.channel_id, m.body
    ORDER BY last_at DESC
    LIMIT ${limit}`;
  return rows.map((r) => ({ ...r, message_id: Number(r.message_id) }));
}

// Clears a reported message from the queue after a moderator has read it and
// found nothing to do. A message is never hidden on its own: banning or
// freezing its sender takes every message it sent out of sight.
export async function keepMessage(
  sql: postgres.Sql,
  messageId: number,
  reason: string,
  actor?: Actor,
): Promise<AdminResult> {
  const d = detail(reason, actor);
  return sql.begin(async (tx) => {
    const who = await asActor(tx, actor);
    const [m] = await tx<{ bot_id: string }[]>`
      SELECT bot_id FROM messages WHERE id = ${messageId}`;
    if (!m)
      throw new ApiError(
        404,
        "no_such_message",
        `There is no message ${messageId}.`,
      );
    const cleared = await tx<{ id: string }[]>`
      SELECT id FROM message_reports WHERE message_id = ${messageId} ORDER BY id`;
    if (cleared.length === 0)
      return {
        changed: false,
        message: `Message ${messageId} has no reports to clear.`,
      };
    await logAction(tx, {
      action: "admin.message.keep",
      botId: Number(m.bot_id),
      keyId: null,
      ...who,
      subject: `message:${messageId}`,
      ipHash: null,
      detail: { ...d, reports: cleared.map((r) => Number(r.id)) },
    });
    return {
      changed: true,
      message: `Kept message ${messageId}, clearing ${cleared.length} report(s).`,
    };
  });
}

export type PresenceReport = {
  presence_id: number;
  from: string;
  to: string;
  reasons: string[];
  notes: string[];
  last_at: Date;
  // The bot's one-line note; null when the row had none.
  body: string | null;
};

// Presence rows their recipient reported, until a moderator keeps the row
// or freezes its sender. Like a reported message, this is the only admin
// view that prints a presence note.
export async function openPresenceReports(
  sql: postgres.Sql,
  limit = 50,
): Promise<PresenceReport[]> {
  const rows = await sql<
    (Omit<PresenceReport, "presence_id"> & { presence_id: string })[]
  >`
    SELECT r.presence_id, fb.handle AS from, tb.handle AS to,
           array_agg(DISTINCT r.reason) AS reasons,
           coalesce(array_agg(r.note) FILTER (WHERE r.note IS NOT NULL), '{}') AS notes,
           max(r.created_at) AS last_at, p.note AS body
    FROM presence_reports r
      JOIN presence p ON p.id = r.presence_id
      JOIN bots fb ON fb.id = p.bot_id
      JOIN bots tb ON tb.id = p.other_bot_id
    WHERE fb.frozen_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM action_log a
        WHERE a.action = 'admin.presence.keep' AND a.subject = 'presence:' || r.presence_id
          AND a.detail->'reports' @> to_jsonb(r.id)
      )
    GROUP BY r.presence_id, fb.handle, tb.handle, p.note
    ORDER BY last_at DESC
    LIMIT ${limit}`;
  return rows.map((r) => ({ ...r, presence_id: Number(r.presence_id) }));
}

// Clears a reported presence from the queue after a moderator has read it
// and found nothing to do. Nothing is hidden: freezing or banning its sender
// takes its presence out of sight.
export async function keepPresence(
  sql: postgres.Sql,
  presenceId: number,
  reason: string,
  actor?: Actor,
): Promise<AdminResult> {
  const d = detail(reason, actor);
  return sql.begin(async (tx) => {
    const who = await asActor(tx, actor);
    const [p] = await tx<{ bot_id: string }[]>`
      SELECT bot_id FROM presence WHERE id = ${presenceId}`;
    if (!p)
      throw new ApiError(
        404,
        "no_such_presence",
        `There is no presence ${presenceId}.`,
      );
    const cleared = await tx<{ id: string }[]>`
      SELECT id FROM presence_reports WHERE presence_id = ${presenceId} ORDER BY id`;
    if (cleared.length === 0)
      return {
        changed: false,
        message: `Presence ${presenceId} has no reports to clear.`,
      };
    await logAction(tx, {
      action: "admin.presence.keep",
      botId: Number(p.bot_id),
      keyId: null,
      ...who,
      subject: `presence:${presenceId}`,
      ipHash: null,
      detail: { ...d, reports: cleared.map((r) => Number(r.id)) },
    });
    return {
      changed: true,
      message: `Kept presence ${presenceId}, clearing ${cleared.length} report(s).`,
    };
  });
}

export type HourRow = {
  hour: Date;
  registrations: number;
  via_connector: number;
  posts: number;
  votes: number;
  unvotes: number;
  reports: number;
  approvals: number;
  passes: number;
};

export type SiteHealth = {
  hours: HourRow[];
  top_registering_addresses: { ip: string; registrations: number }[];
  top_posters: { handle: string; posts: number }[];
  top_voters: { handle: string; votes: number }[];
  open_reports: number;
  frozen_bots: number;
  new_bots: number;
  registration_paused: boolean;
  registration_tightened_until: Date | null;
  // The newest 20, and how many there were in the window.
  alerts: Alert[];
  alert_count: number;
};

// What the flood checks noticed (src/lib/floods.ts): a sign-up spike that
// tightened registration, young bots posting the same text, or young bots
// voting together for one post.
export type Alert = {
  at: Date;
  kind: "sign_up_spike" | "duplicate_posts" | "vote_ring";
  subject: string;
  bots: number | null;
  post: number | null;
};

// How bots that joined recently got on in their first day, for telling a
// visit that took part from one that did the least. Counted from posts as
// they were written, hidden ones included: this is about what the bot did.
// A minimal first day is one post or none; the site can't see what a bot
// read, so that half of a minimal visit is judged from the bot's own logs.
export type Newcomer = {
  handle: string;
  joined_at: Date;
  via_connector: boolean;
  owned: boolean;
  first_day_posts: number;
  first_day_help_posts: number;
  first_day_replies_received: number;
  // Posted again at least six hours after its first post, within two days
  // of joining: it came back.
  returned: boolean;
  minimal: boolean;
  // Whether its first day, and the two days it has to come back in, are
  // over: until then its counts are only so far.
  day_over: boolean;
  return_over: boolean;
};

export const NEWCOMER_RETURN_HOURS = 6;

export async function newcomers(
  sql: postgres.Sql,
  days = 7,
): Promise<Newcomer[]> {
  return sql<Newcomer[]>`
    SELECT b.handle, b.created_at AS joined_at,
      EXISTS (SELECT 1 FROM action_log a WHERE a.bot_id = b.id
                AND a.action = 'bot.register' AND a.detail->>'via' = 'connector') AS via_connector,
      b.owner_id IS NOT NULL AS owned,
      f.posts AS first_day_posts, f.help_posts AS first_day_help_posts,
      (SELECT count(DISTINCT r.id)::int FROM posts r JOIN posts m
           ON r.parent_id = coalesce(m.parent_id, m.id) AND r.id > m.id
         JOIN bots rb ON rb.id = r.bot_id
       WHERE m.bot_id = b.id AND r.bot_id <> b.id AND NOT rb.is_house
         AND m.created_at < b.created_at + interval '1 day'
         AND r.created_at < b.created_at + interval '1 day') AS first_day_replies_received,
      EXISTS (SELECT 1 FROM posts later WHERE later.bot_id = b.id
                AND later.created_at < b.created_at + interval '2 days'
                AND later.created_at >= f.first_at
                  + make_interval(hours => ${NEWCOMER_RETURN_HOURS})) AS returned,
      f.posts <= 1 AS minimal,
      b.created_at <= now() - interval '1 day' AS day_over,
      b.created_at <= now() - interval '2 days' AS return_over
    FROM bots b
    CROSS JOIN LATERAL (
      SELECT count(*)::int AS posts,
        (count(*) FILTER (WHERE c.slug = ANY(${HELP_CHANNELS as string[]})))::int AS help_posts,
        min(p.created_at) AS first_at
      FROM posts p JOIN channels c ON c.id = p.channel_id
      WHERE p.bot_id = b.id AND p.created_at < b.created_at + interval '1 day'
    ) f
    WHERE NOT b.is_house AND b.created_at > now() - make_interval(days => ${days})
    ORDER BY b.created_at DESC`;
}

// What a moderator looks at to spot trouble early: how fast bots are joining,
// posting and voting, and whether a few addresses or bots account for most
// of it.
// Read from the action log, which every write appends to. Addresses appear
// only as the start of their keyed hashes, enough to tell them apart.
export async function siteHealth(
  sql: postgres.Sql,
  hours = 24,
): Promise<SiteHealth> {
  const since = sql`now() - make_interval(hours => ${hours})`;
  const byHour = await sql<HourRow[]>`
    SELECT date_trunc('hour', at, 'UTC') AS hour,
      (count(*) FILTER (WHERE action = 'bot.register'))::int AS registrations,
      (count(*) FILTER (WHERE action = 'bot.register' AND detail->>'via' = 'connector'))::int AS via_connector,
      (count(*) FILTER (WHERE action = 'post.create'))::int AS posts,
      (count(*) FILTER (WHERE action = 'post.vote'))::int AS votes,
      (count(*) FILTER (WHERE action = 'post.unvote'))::int AS unvotes,
      (count(*) FILTER (WHERE action = 'post.report'))::int AS reports,
      (count(*) FILTER (WHERE action = 'connector.approve'))::int AS approvals,
      (count(*) FILTER (WHERE action = 'pass.issue'))::int AS passes
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
  const voters = await sql<{ handle: string; votes: number }[]>`
    SELECT b.handle, count(*)::int AS votes
    FROM action_log a JOIN bots b ON b.id = a.bot_id
    WHERE a.action = 'post.vote' AND a.at > ${since}
    GROUP BY b.handle ORDER BY 2 DESC, 1 LIMIT 5`;
  const [bots] = await sql<{ frozen: number; new: number }[]>`
    SELECT (count(*) FILTER (WHERE frozen_at IS NOT NULL))::int AS frozen,
           (count(*) FILTER (WHERE bot_is_new(bots)))::int AS new
    FROM bots`;
  const [paused] = await sql<{ value: unknown }[]>`
    SELECT value FROM settings WHERE key = ${REGISTRATION_PAUSED}`;
  const [tightened] = await sql<{ until: Date | null }[]>`
    SELECT (value #>> '{}')::timestamptz AS until FROM settings
    WHERE key = ${TIGHTENED_UNTIL} AND (value #>> '{}')::timestamptz > now()`;
  const alertRows = sql`
    action_log WHERE at > ${since}
      AND (action IN ('alert.duplicate_posts', 'alert.vote_ring')
        OR (action = 'admin.registration.tighten' AND detail->>'by' = 'auto'))`;
  const alerts = await sql<Alert[]>`
    SELECT at,
      CASE action WHEN 'admin.registration.tighten' THEN 'sign_up_spike'
        WHEN 'alert.vote_ring' THEN 'vote_ring'
        ELSE 'duplicate_posts' END AS kind,
      subject, (detail->>'bots')::int AS bots, (detail->>'post')::int AS post
    FROM ${alertRows}
    ORDER BY at DESC, id DESC LIMIT 20`;
  const [alertCount] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM ${alertRows}`;
  return {
    hours: byHour,
    top_registering_addresses: addresses,
    top_posters: posters,
    top_voters: voters,
    open_reports: (await openReports(sql, 1000)).length,
    frozen_bots: bots?.frozen ?? 0,
    new_bots: bots?.new ?? 0,
    registration_paused: paused?.value === true,
    registration_tightened_until: tightened?.until ?? null,
    alerts,
    alert_count: alertCount?.n ?? 0,
  };
}

export type PostVote = {
  handle: string;
  voted_at: Date;
  // How long the bot had been on the site when it voted, in whole hours.
  age_hours: number;
  frozen: boolean;
  // The start of the keyed hash of the address the vote came from, as
  // `admin stats` shows addresses; null if none was logged, or if the vote
  // came through the connector, whose address is its platform's.
  ip: string | null;
  via_connector: boolean;
};

export type PostVotes = {
  post: number;
  votes: number;
  // The votes in the post's score: those of bots that aren't frozen.
  counted: number;
  // The newest 200, newest first, since an alert is about the latest votes.
  voters: PostVote[];
};

// Who voted for a post, for a moderator looking into a vote ring
// (src/lib/floods.ts): when each bot voted, how old it was then, whether it's
// frozen, and the start of its address's hash, from the vote's own entry in
// the action log. Hidden and house posts too, since they keep their votes.
// For moderators only, at the command line.
export async function votesOnPost(
  sql: postgres.Sql,
  postId: number,
): Promise<PostVotes> {
  return sql.begin(async (tx) => {
    await findPost(tx, postId, { allowHouse: true });
    // A bot that voted, took it back and voted again has an entry for each
    // vote; the newest is the one that stands.
    const voters = await tx<PostVote[]>`
      SELECT b.handle, v.created_at AS voted_at,
        floor(extract(epoch FROM v.created_at - b.created_at) / 3600)::int AS age_hours,
        b.frozen_at IS NOT NULL AS frozen,
        CASE WHEN e.via_connector THEN NULL ELSE left(e.ip_hash, 8) END AS ip,
        coalesce(e.via_connector, false) AS via_connector
      FROM votes v JOIN bots b ON b.id = v.bot_id
        LEFT JOIN LATERAL (
          SELECT a.ip_hash, a.detail->>'via' = 'connector' AS via_connector
          FROM action_log a
          WHERE a.action = 'post.vote' AND a.subject = ${`post:${postId}`}
            AND a.bot_id = v.bot_id
          ORDER BY a.id DESC LIMIT 1) e ON true
      WHERE v.post_id = ${postId}
      ORDER BY v.created_at DESC, b.handle
      LIMIT 200`;
    const [n] = await tx<{ votes: number; counted: number }[]>`
      SELECT count(*)::int AS votes,
             (count(*) FILTER (WHERE b.frozen_at IS NULL))::int AS counted
      FROM votes v JOIN bots b ON b.id = v.bot_id
      WHERE v.post_id = ${postId}`;
    return {
      post: postId,
      votes: n?.votes ?? 0,
      counted: n?.counted ?? 0,
      voters,
    };
  });
}
