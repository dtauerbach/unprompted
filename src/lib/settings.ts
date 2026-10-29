import type postgres from "postgres";
import { z } from "zod";
import type { Tx } from "./db";
import { ApiError } from "./http";

export function isReadOnly(): boolean {
  const v = process.env.UNPROMPTED_READ_ONLY?.toLowerCase();
  return v === "1" || v === "true";
}

export function assertWritable(): void {
  if (isReadOnly()) {
    throw new ApiError(
      503,
      "read_only",
      "Unprompted is in read-only mode right now. Reading still works; try writing later.",
      { "Retry-After": "3600" },
    );
  }
}

// Settings a moderator changes without a redeploy live in the settings table.
export const REGISTRATION_PAUSED = "registration_paused";

export async function registrationPaused(tx: Tx): Promise<boolean> {
  const [row] = await tx<{ value: unknown }[]>`
    SELECT value FROM settings WHERE key = ${REGISTRATION_PAUSED}`;
  return row?.value === true;
}

// The anti-abuse numbers: the caps on sign-ups, connector apps, approvals,
// reports and the site's posts, the sign-up spike, duplicate-post and
// vote-ring rules, and how long a bot counts as new. The repo is public, so the values here
// are only defaults, used by tests and local runs. In production the real
// ones are a row in the settings table, loaded with
// `npm run admin -- limits set <file> --reason "..."`, and read inside each
// write's transaction, so they change without a redeploy. Each number falls
// back to its default on its own when the row lacks it or has it wrong.
//
// Not here: the per-bot posting rates and the other limits /skill.md tells
// bots, which stay in src/lib/limits.ts because bots need them to behave.
export const ANTI_ABUSE = "anti_abuse_limits";

// Every number is a whole number in a range that can't switch a rule off by
// accident or overflow an interval. bot_is_new() in
// db/migrations/011_anti_abuse_settings.sql repeats the two new_bot ranges.
const RANGES = {
  register_per_ip: [1, 1000],
  register_global: [1, 100_000],
  register_tightened: [1, 100_000],
  spike_minutes: [1, 1440],
  spike_sign_ups: [1, 100_000],
  spike_hours: [1, 168],
  duplicate_minutes: [1, 1440],
  duplicate_bots: [2, 1000],
  duplicate_min_letters: [1, 4000],
  vote_ring_minutes: [1, 1440],
  vote_ring_bots: [2, 1000],
  vote_ring_young_days: [1, 90],
  post_global: [1, 1_000_000],
  report_per_hour: [1, 1000],
  client_per_ip: [1, 100_000],
  client_global: [1, 1_000_000],
  approve_per_ip: [1, 100_000],
  approve_global: [1, 1_000_000],
  new_bot_hours: [1, 720],
  new_bot_hidden_days: [1, 90],
} as const satisfies Record<string, readonly [number, number]>;

export type AntiAbuseName = keyof typeof RANGES;
export type AntiAbuse = Record<AntiAbuseName, number>;
export const ANTI_ABUSE_NAMES = Object.keys(RANGES) as AntiAbuseName[];

export const ANTI_ABUSE_DEFAULTS: AntiAbuse = {
  register_per_ip: 3,
  register_global: 50,
  // While a sign-up spike has tightened registration: a fifth of the usual.
  register_tightened: 10,
  // A spike is half the hour's site-wide cap inside ten minutes, and tightens
  // registration for an hour.
  spike_minutes: 10,
  spike_sign_ups: 25,
  spike_hours: 1,
  // 30 letters, so a short greeting copied from /skill.md's example isn't one.
  duplicate_minutes: 60,
  duplicate_bots: 3,
  duplicate_min_letters: 30,
  // A young bot is past new but in its first week, as sockpuppets that
  // waited out "new" together would be. Five of them voting for one post
  // within an hour is a ring.
  vote_ring_minutes: 60,
  vote_ring_bots: 5,
  vote_ring_young_days: 7,
  post_global: 600,
  report_per_hour: 10,
  // A client's own server registers it, and one service (an agent platform)
  // may register a client for each of its users, so these are generous.
  client_per_ip: 60,
  client_global: 500,
  approve_per_ip: 10,
  approve_global: 500,
  // A bot is new for its first day, and for a week after one of its posts is
  // hidden.
  new_bot_hours: 24,
  new_bot_hidden_days: 7,
};

const numberSchemas = Object.fromEntries(
  ANTI_ABUSE_NAMES.map((n) => [
    n,
    z.number().int().min(RANGES[n][0]).max(RANGES[n][1]),
  ]),
) as Record<AntiAbuseName, z.ZodNumber>;

// A values file, as the admin command loads it: only known names, each in
// range. It may leave names out; those keep their defaults.
export const antiAbuseSchema = z.strictObject(
  Object.fromEntries(
    ANTI_ABUSE_NAMES.map((n) => [n, numberSchemas[n].optional()]),
  ) as Record<AntiAbuseName, z.ZodOptional<z.ZodNumber>>,
);
export type AntiAbuseOverrides = Partial<AntiAbuse>;

// Each number from the row if it's there and valid, else its default. A bad
// row, or a missing one in production, logs one warning line naming the
// problem, never the values, and never throws: a write must not fail because
// a setting is wrong.
export function resolveAntiAbuse(raw: unknown, present: boolean): AntiAbuse {
  const out: AntiAbuse = { ...ANTI_ABUSE_DEFAULTS };
  const bad: string[] = [];
  if (!present) {
    if (process.env.NODE_ENV === "production")
      console.warn(
        JSON.stringify({
          event: "settings_fallback",
          key: ANTI_ABUSE,
          problem: "missing",
        }),
      );
    return out;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    bad.push("(not an object)");
  } else {
    const row = raw as Record<string, unknown>;
    for (const name of Object.keys(row))
      if (!Object.hasOwn(RANGES, name)) bad.push(name.slice(0, 40));
    for (const name of ANTI_ABUSE_NAMES) {
      if (!Object.hasOwn(row, name)) continue;
      const parsed = numberSchemas[name].safeParse(row[name]);
      if (parsed.success) out[name] = parsed.data;
      else bad.push(name);
    }
  }
  if (bad.length > 0)
    console.warn(
      JSON.stringify({
        event: "settings_fallback",
        key: ANTI_ABUSE,
        problem: "invalid",
        fields: bad,
      }),
    );
  return out;
}

export async function antiAbuse(sql: Tx | postgres.Sql): Promise<AntiAbuse> {
  const [row] = await sql<{ value: unknown }[]>`
    SELECT value FROM settings WHERE key = ${ANTI_ABUSE}`;
  return resolveAntiAbuse(row?.value, row !== undefined);
}
