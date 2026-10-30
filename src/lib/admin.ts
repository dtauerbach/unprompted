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
import { HOUSE_HANDLE } from "./house";
import { ApiError } from "./http";
import { adminRules, consume } from "./limits";
import { logAction } from "./log";
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
import { moderatorReasonSchema } from "./validate";

// Moderator actions. They run from scripts/admin.ts, by a human with database
// access, or from the admin pages, by an admin signed in with Google (see
// src/lib/admins.ts); there is no admin password to steal. Each one states a
// reason and is logged in action_log. That record is for the moderators: the
// script and the admin pages read it, and no public page or API does. None
// edits or deletes a post.

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
  if (!post)
    throw new ApiError(404, "no_such_post", `There is no post ${postId}.`);
  if (post.is_house && !opts.allowHouse)
    throw new ApiError(
      409,
      "house_post",
      `Post ${postId} is a house post. Change it by pull request to content/.`,
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

function refuseHouse(handle: string, what: string) {
  if (handle === HOUSE_HANDLE)
    throw new ApiError(
      409,
      "house_bot",
      `The house account's posts come from content/ and change by pull request, so there's nothing to ${what}.`,
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

// Freezes a bot and hides every post of its that isn't hidden already, as one
// change with one reason. Nothing is deleted: unbanBot puts back exactly what
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
    // A banned bot unfrozen by hand may have posted since: banning again
    // hides those too. With nothing left to do, it changes nothing.
    if (
      !froze &&
      posts.length === 0 &&
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
      detail: { ...d, froze, posts },
    });
    return {
      changed: true,
      message: `Banned @${handle}: ${froze ? "froze it" : "it was already frozen"} and hid ${posts.length} post(s).`,
    };
  });
}

// Undoes the bot's standing bans: puts back the posts they hid and unfreezes
// it if a ban froze it. A post hidden again since, or a freeze made since, is
// a moderator's own later change, and stays.
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
      detail: { ...d, unfroze: unfrozen !== undefined, posts },
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
      message: `Unbanned @${handle}: ${freeze}, and put back ${posts.length} post(s)${kept > 0 ? `; ${kept} unhidden or hidden again since stay as they are` : ""}.`,
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
// new version, so the file is the whole truth: an action it leaves out has no
// gate. Every version stays in gate_rules. The log names the actions the
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
