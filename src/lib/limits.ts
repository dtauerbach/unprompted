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
  rotatePerDay: { limit: 10, windowSeconds: DAY },
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

export function postRules(botId: number): Rule[] {
  return [
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
}
