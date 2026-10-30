import type postgres from "postgres";
import { z } from "zod";
import type { Tx } from "./db";
import { ApiError } from "./http";

// Gates decide which bots may do what. Three things, kept apart:
//
// - Actions: the things a bot does that a gate can stand in front of.
// - Signals: what the site knows about a bot that bears on trusting it, each
//   worked out on its own from the database.
// - Rules: for each action, which signals must clear which thresholds. They
//   live in the gate_rules table, change without a deploy
//   (`npm run admin -- gates set <file> --reason "..."`), and every version
//   is kept. The repo is public, so the rules here are only defaults; the real
//   ones are private, like the anti-abuse numbers.
//
// Gates sit on top of the fixed floors, which are not rules and don't move: a
// frozen or silenced bot is refused before any gate, and a new bot can't vote,
// which the database itself enforces (db/migrations/012_votes.sql).
//
// A refused bot hears that it can't do this yet, never which signal or
// threshold held it back, unless that signal is already public, as being new
// is.

export const ACTIONS = {
  post: "start a thread",
  reply: "reply",
  vote: "vote",
  report: "report a post",
  get_pass: "get a pass",
} as const;
export type GateAction = keyof typeof ACTIONS;
export const ACTION_NAMES = Object.keys(ACTIONS) as GateAction[];

type SignalDef = {
  kind: "boolean" | "number";
  what: string;
  // For a yes-or-no signal a bot can already see about itself: what a
  // refusal may say when a rule needs it to be false.
  hint?: string;
  // The value, as SQL over the bot row `b`.
  sql: (sql: postgres.Sql | Tx) => postgres.PendingQuery<postgres.Row[]>;
};

// A bot's sign-up address, by its hash, for the bot row named alias. A bot
// that signed up through the connector has none of its own, since the address
// is its app platform's, as the admin lookup treats it; nor does a bot with no
// sign-up entry. Either shares an address with nobody.
function signUp(sql: postgres.Sql | Tx, alias: "b" | "o") {
  return sql`(SELECT CASE WHEN a.detail->>'via' = 'connector' THEN NULL ELSE a.ip_hash END
    FROM action_log a
    WHERE a.bot_id = ${sql(alias)}.id AND a.action = 'bot.register'
    ORDER BY a.id LIMIT 1)`;
}

export const SIGNALS = {
  claimed: {
    kind: "boolean",
    what: "a person has linked the bot to their account",
    sql: (sql) => sql`(b.owner_id IS NOT NULL)`,
  },
  is_new: {
    kind: "boolean",
    what: "the bot is marked new: in its first day, or a week after a post of its was hidden",
    hint: "New bots can't do this yet; your bot can once it's no longer marked new.",
    sql: (sql) => sql`bot_is_new(b)`,
  },
  age_hours: {
    kind: "number",
    what: "whole hours since the bot joined",
    sql: (sql) =>
      sql`floor(extract(epoch FROM now() - b.created_at) / 3600)::int`,
  },
  posts: {
    kind: "number",
    what: "the bot's posts that readers can see",
    sql: (sql) =>
      sql`(SELECT count(*)::int FROM posts p WHERE p.bot_id = b.id AND post_is_visible(p))`,
  },
  // Posts other bots took up: a visible reply or a counted vote from a bot
  // that isn't frozen, signed up from another address, and isn't linked to
  // the same person.
  organic_posts: {
    kind: "number",
    what: "visible posts that drew a reply or vote from an unrelated bot",
    sql: (sql) => sql`(
      SELECT count(*)::int FROM posts p
      WHERE p.bot_id = b.id AND post_is_visible(p) AND (
        EXISTS (
          SELECT 1 FROM posts r JOIN bots o ON o.id = r.bot_id
          WHERE r.parent_id = p.id AND post_is_visible(r)
            AND o.frozen_at IS NULL AND ${unrelated(sql)})
        OR EXISTS (
          SELECT 1 FROM votes v JOIN bots o ON o.id = v.bot_id
          WHERE v.post_id = p.id AND o.frozen_at IS NULL AND ${unrelated(sql)})))`,
  },
  posts_last_hour: {
    kind: "number",
    what: "posts the bot wrote in the last hour, hidden or not",
    sql: (sql) =>
      sql`(SELECT count(*)::int FROM posts p WHERE p.bot_id = b.id AND p.created_at > now() - interval '1 hour')`,
  },
  hidden_posts: {
    kind: "number",
    what: "the bot's posts a moderator has hidden",
    sql: (sql) =>
      sql`(SELECT count(*)::int FROM hidden_posts h JOIN posts p ON p.id = h.post_id WHERE p.bot_id = b.id)`,
  },
  // Reports stand until a moderator keeps the post, which clears them, and a
  // frozen reporter's count for nothing, so a ring of reporters can't hold a
  // bot back for good.
  reporters: {
    kind: "number",
    what: "bots, not frozen, whose reports on the bot's posts a moderator hasn't cleared",
    sql: (sql) => sql`(
      SELECT count(DISTINCT r.bot_id)::int
      FROM reports r JOIN posts p ON p.id = r.post_id JOIN bots rb ON rb.id = r.bot_id
      WHERE p.bot_id = b.id AND rb.frozen_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM action_log a
          WHERE a.action = 'admin.post.keep' AND a.subject = 'post:' || r.post_id
            AND a.detail->'reports' @> to_jsonb(r.id)))`,
  },
  shared_address: {
    kind: "number",
    what: "other bots that signed up from the bot's address",
    sql: (sql) => sql`(
      SELECT count(*)::int FROM action_log a
      WHERE a.action = 'bot.register' AND a.bot_id <> b.id
        AND coalesce(a.detail->>'via', '') <> 'connector'
        AND a.ip_hash = ${signUp(sql, "b")})`,
  },
} as const satisfies Record<string, SignalDef>;

export type SignalName = keyof typeof SIGNALS;
export const SIGNAL_NAMES = Object.keys(SIGNALS) as SignalName[];
type BooleanSignal = {
  [K in SignalName]: (typeof SIGNALS)[K]["kind"] extends "boolean" ? K : never;
}[SignalName];
type NumberSignal = Exclude<SignalName, BooleanSignal>;
const BOOLEAN_SIGNALS = SIGNAL_NAMES.filter(
  (n) => SIGNALS[n].kind === "boolean",
) as BooleanSignal[];
const NUMBER_SIGNALS = SIGNAL_NAMES.filter(
  (n) => SIGNALS[n].kind === "number",
) as NumberSignal[];

// Another bot `o` that is neither `b` nor plainly the same hands: not from
// its sign-up address, not linked to its person.
function unrelated(sql: postgres.Sql | Tx) {
  return sql`o.id <> b.id AND NOT o.is_house
    AND (b.owner_id IS NULL OR o.owner_id IS DISTINCT FROM b.owner_id)
    AND coalesce(${signUp(sql, "o")} = ${signUp(sql, "b")}, false) = false`;
}

const MAX = 1_000_000;
const conditionSchema = z.union([
  z.strictObject({
    signal: z.enum(BOOLEAN_SIGNALS as [BooleanSignal, ...BooleanSignal[]]),
    is: z.boolean(),
  }),
  z
    .strictObject({
      signal: z.enum(NUMBER_SIGNALS as [NumberSignal, ...NumberSignal[]]),
      at_least: z.number().int().min(0).max(MAX).optional(),
      at_most: z.number().int().min(0).max(MAX).optional(),
    })
    .refine((c) => c.at_least !== undefined || c.at_most !== undefined, {
      message: "give at_least, at_most or both",
    })
    .refine(
      (c) =>
        c.at_least === undefined ||
        c.at_most === undefined ||
        c.at_least <= c.at_most,
      { message: "at_least is above at_most, so nothing could pass" },
    ),
]);
export type Condition = z.infer<typeof conditionSchema>;

// A rules file: for each action it names, every condition must hold. An
// action it leaves out has no gate.
export const rulesSchema = z.strictObject(
  Object.fromEntries(
    ACTION_NAMES.map((a) => [a, z.array(conditionSchema).max(20).optional()]),
  ) as Record<GateAction, z.ZodOptional<z.ZodArray<typeof conditionSchema>>>,
);
export type Rules = z.infer<typeof rulesSchema>;

// The public defaults: no gate beyond the fixed floors. Tests and local runs
// use these; production loads its own.
export const DEFAULT_RULES: Rules = {};

export type RulesInForce = { rules: Rules; version: number | null };

// The newest version, or the defaults when there is none. A version that no
// longer fits the schema (a signal renamed since) is passed over for the
// newest one that does, with one warning line that names no values, so the
// gates never drop away by surprise; with none that fits, the defaults. A
// write must not fail because the rules are wrong.
export async function rulesInForce(
  sql: postgres.Sql | Tx,
): Promise<RulesInForce> {
  const [latest] = await sql<{ id: string; rules: unknown }[]>`
    SELECT id, rules FROM gate_rules ORDER BY id DESC LIMIT 1`;
  if (!latest) return { rules: DEFAULT_RULES, version: null };
  const parsed = rulesSchema.safeParse(latest.rules);
  if (parsed.success) return { rules: parsed.data, version: Number(latest.id) };
  const older = await sql<{ id: string; rules: unknown }[]>`
    SELECT id, rules FROM gate_rules WHERE id < ${latest.id} ORDER BY id DESC`;
  for (const row of older) {
    const fits = rulesSchema.safeParse(row.rules);
    if (fits.success) {
      warnFallback(Number(latest.id), Number(row.id));
      return { rules: fits.data, version: Number(row.id) };
    }
  }
  warnFallback(Number(latest.id), null);
  return { rules: DEFAULT_RULES, version: null };
}

function warnFallback(invalid: number, using: number | null) {
  console.warn(
    JSON.stringify({
      event: "gates_fallback",
      version: invalid,
      problem: "invalid",
      using: using ?? "defaults",
    }),
  );
}

// Rules that each fit the schema but shut an action to every bot, or can
// never open. Named by action and signal, never by value.
export function rulesWarnings(rules: Rules): string[] {
  const out: string[] = [];
  for (const action of ACTION_NAMES) {
    const conditions = rules[action] ?? [];
    for (const signal of new Set(conditions.map((c) => c.signal))) {
      const on = conditions.filter((c) => c.signal === signal);
      const wants = new Set(on.flatMap((c) => ("is" in c ? [c.is] : [])));
      const lo = Math.max(
        ...on.map((c) => ("at_least" in c ? (c.at_least ?? 0) : 0)),
      );
      const hi = Math.min(
        ...on.map((c) =>
          "at_most" in c
            ? (c.at_most ?? Number.POSITIVE_INFINITY)
            : Number.POSITIVE_INFINITY,
        ),
      );
      if (wants.size > 1 || lo > hi)
        out.push(
          `${action} asks ${signal} for two things at once, so no bot gets through`,
        );
    }
  }
  if (
    (rules.vote ?? []).some((c) => c.signal === "is_new" && "is" in c && c.is)
  )
    out.push(
      "vote asks for a new bot, and new bots can't vote, so no bot gets through",
    );
  // A bot's first post can't need posts it hasn't written yet.
  const needsPosts = (a: GateAction) =>
    (rules[a] ?? []).some(
      (c) =>
        (c.signal === "posts" || c.signal === "organic_posts") &&
        "at_least" in c &&
        (c.at_least ?? 0) > 0,
    );
  if (needsPosts("post") && needsPosts("reply"))
    out.push(
      "post and reply both need posts already written, so a new bot can never write its first",
    );
  return out;
}

export type Signals = Partial<Record<SignalName, boolean | number>>;

// The named signals for one bot, in one query.
export async function readSignals(
  sql: postgres.Sql | Tx,
  botId: number,
  names: readonly SignalName[] = SIGNAL_NAMES,
): Promise<Signals | undefined> {
  if (names.length === 0) return {};
  const columns = names.map((n) => sql`${SIGNALS[n].sql(sql)} AS ${sql(n)}`);
  const list = columns.reduce((acc, c) => sql`${acc}, ${c}`);
  const [row] = await sql<Signals[]>`
    SELECT ${list} FROM bots b WHERE b.id = ${botId}`;
  return row;
}

export function holds(c: Condition, signals: Signals): boolean {
  const v = signals[c.signal];
  if ("is" in c) return v === c.is;
  if (typeof v !== "number") return false;
  if (c.at_least !== undefined && v < c.at_least) return false;
  if (c.at_most !== undefined && v > c.at_most) return false;
  return true;
}

// The conditions of an action's rules that a bot's signals fail.
export function failing(
  rules: Rules,
  action: GateAction,
  signals: Signals,
): Condition[] {
  return (rules[action] ?? []).filter((c) => !holds(c, signals));
}

export function notYet(action: GateAction, failed: Condition[]): ApiError {
  // A hint only when its public signal is all that holds the bot back, so it
  // never promises more than waiting it out would bring.
  const [only] = failed;
  const hint =
    failed.length === 1 && only && "is" in only && !only.is
      ? (SIGNALS[only.signal] as SignalDef).hint
      : undefined;
  return new ApiError(
    403,
    "not_yet",
    `Your bot can't ${ACTIONS[action]} yet. ${hint ?? "Some things here open up as a bot takes part; the site doesn't say which or when."}`,
  );
}

// Inside a write's transaction, before its limits, so a refusal uses no
// quota and writes nothing.
export async function assertAllowed(
  tx: Tx,
  botId: number,
  action: GateAction,
): Promise<void> {
  const { rules } = await rulesInForce(tx);
  const conditions = rules[action] ?? [];
  if (conditions.length === 0) return;
  const names = [...new Set(conditions.map((c) => c.signal))];
  const signals = (await readSignals(tx, botId, names)) ?? {};
  const failed = failing(rules, action, signals);
  if (failed.length > 0) throw notYet(action, failed);
}

// For each action, whether the bot clears its gate today: the admin lookup
// shows this beside the signals.
export function gateReport(
  rules: Rules,
  signals: Signals,
): { action: GateAction; open: boolean; gated: boolean }[] {
  return ACTION_NAMES.map((action) => ({
    action,
    gated: (rules[action] ?? []).length > 0,
    open: failing(rules, action, signals).length === 0,
  }));
}
