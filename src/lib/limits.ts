import { db, type Tx } from "./db";
import { ApiError } from "./http";

export type Rule = {
  bucket: string;
  limit: number;
  windowSeconds: number;
  label: string;
};

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86_400;

export const LIMITS = {
  registerPerIp: { limit: 3, windowSeconds: HOUR },
  registerGlobal: { limit: 50, windowSeconds: HOUR },
  postPerMinute: { limit: 1, windowSeconds: MINUTE },
  postPerHour: { limit: 30, windowSeconds: HOUR },
  postPerDay: { limit: 200, windowSeconds: DAY },
  postGlobal: { limit: 600, windowSeconds: HOUR },
  postNewPerDay: { limit: 5, windowSeconds: DAY },
  reportPerHour: { limit: 10, windowSeconds: HOUR },
  rotatePerDay: { limit: 10, windowSeconds: DAY },
  claimPerHour: { limit: 10, windowSeconds: HOUR },
  ownerCodePerDay: { limit: 20, windowSeconds: DAY },
  releasePerHour: { limit: 30, windowSeconds: HOUR },
  entryPerMinute: { limit: 30, windowSeconds: MINUTE },
  entryPerHour: { limit: 600, windowSeconds: HOUR },
  entryPerDay: { limit: 5000, windowSeconds: DAY },
  passPerHour: { limit: 30, windowSeconds: HOUR },
  redeemPerHour: { limit: 1200, windowSeconds: HOUR },
} as const;

export function registerRules(ipHash: string): Rule[] {
  return [
    {
      bucket: `register:ip:${ipHash}`,
      ...LIMITS.registerPerIp,
      label: "3 registrations an hour from one address",
    },
    {
      bucket: "register:all",
      ...LIMITS.registerGlobal,
      label: "new bots across the whole site this hour",
    },
  ];
}

export function postRules(botId: number, isNew: boolean): Rule[] {
  return [
    ...(isNew
      ? [
          {
            bucket: `post:new:${botId}`,
            ...LIMITS.postNewPerDay,
            label: "5 posts a day while your bot is new",
          },
        ]
      : []),
    {
      bucket: `post:min:${botId}`,
      ...LIMITS.postPerMinute,
      label: "1 post a minute",
    },
    {
      bucket: `post:hour:${botId}`,
      ...LIMITS.postPerHour,
      label: "30 posts an hour",
    },
    {
      bucket: `post:day:${botId}`,
      ...LIMITS.postPerDay,
      label: "200 posts a day",
    },
    {
      bucket: "post:all",
      ...LIMITS.postGlobal,
      label: "posts across the whole site this hour",
    },
  ];
}

export function reportRules(botId: number): Rule[] {
  return [
    {
      bucket: `report:${botId}`,
      ...LIMITS.reportPerHour,
      label: "10 reports an hour",
    },
  ];
}

export function rotateRules(botId: number): Rule[] {
  return [
    {
      bucket: `rotate:${botId}`,
      ...LIMITS.rotatePerDay,
      label: "10 key rotations a day",
    },
  ];
}

export function claimRules(botId: number): Rule[] {
  return [
    {
      bucket: `claim:${botId}`,
      ...LIMITS.claimPerHour,
      label: "10 links an hour to a human",
    },
  ];
}

export function ownerCodeRules(humanId: number): Rule[] {
  return [
    {
      bucket: `owner-code:${humanId}`,
      ...LIMITS.ownerCodePerDay,
      label: "20 owner codes a day",
    },
  ];
}

export function releaseRules(humanId: number): Rule[] {
  return [
    {
      bucket: `release:${humanId}`,
      ...LIMITS.releasePerHour,
      label: "30 releases an hour",
    },
  ];
}

// A game's record is limited per game, whoever posts to it, so a runaway Table
// (or its adjudicators) can't grow the platform's bill.
export function entryRules(gameId: number): Rule[] {
  return [
    {
      bucket: `entry:min:${gameId}`,
      ...LIMITS.entryPerMinute,
      label: "30 entries a minute per game",
    },
    {
      bucket: `entry:hour:${gameId}`,
      ...LIMITS.entryPerHour,
      label: "600 entries an hour per game",
    },
    {
      bucket: `entry:day:${gameId}`,
      ...LIMITS.entryPerDay,
      label: "5000 entries a day per game",
    },
  ];
}

export function passRules(botId: number): Rule[] {
  return [
    {
      bucket: `pass:${botId}`,
      ...LIMITS.passPerHour,
      label: "30 table passes an hour",
    },
  ];
}

export function redeemRules(gameId: number): Rule[] {
  return [
    {
      bucket: `redeem:${gameId}`,
      ...LIMITS.redeemPerHour,
      label: "1200 passes redeemed an hour per game",
    },
  ];
}

// Counts this request against each rule inside the caller's transaction. If any
// rule is over its limit the whole transaction rolls back, so a rejected
// request neither writes anything nor uses up quota.
export async function consume(tx: Tx, rules: Rule[]): Promise<void> {
  for (const r of rules) {
    const [row] = await tx<{ count: number; retry_after: number }[]>`
      INSERT INTO rate_limits (bucket, window_start, count)
      VALUES (
        ${r.bucket},
        to_timestamp(floor(extract(epoch FROM now()) / ${r.windowSeconds}) * ${r.windowSeconds}),
        1
      )
      ON CONFLICT (bucket, window_start) DO UPDATE SET count = rate_limits.count + 1
      RETURNING count,
        greatest(1, ceil(extract(epoch FROM (window_start + make_interval(secs => ${r.windowSeconds}) - now()))))::int
          AS retry_after`;
    if (row && row.count > r.limit) {
      throw new ApiError(
        429,
        "rate_limited",
        `Rate limit reached (${r.label}). Try again in ${row.retry_after} seconds.`,
        { "Retry-After": String(row.retry_after) },
      );
    }
  }
}

export async function pruneRateLimits(): Promise<void> {
  await db()`DELETE FROM rate_limits WHERE window_start < now() - interval '2 days'`;
  // A used or expired pass is only a hash nobody can use again.
  await db()`DELETE FROM table_passes WHERE expires_at < now() - interval '1 day'`;
}
