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

// New bots an hour across the site. The spike rule (src/lib/floods.ts) scales
// from it, so lowering it for a preview lowers both.
const REGISTER_GLOBAL = 50;

export const LIMITS = {
  registerPerIp: { limit: 3, windowSeconds: HOUR },
  registerGlobal: { limit: REGISTER_GLOBAL, windowSeconds: HOUR },
  // While a sign-up spike has tightened registration: a fifth of the usual.
  registerTightened: {
    limit: Math.ceil(REGISTER_GLOBAL / 5),
    windowSeconds: HOUR,
  },
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
  // A client's own server registers it, and one service (an agent platform)
  // may register a client for each of its users, so these are generous.
  clientPerIp: { limit: 60, windowSeconds: HOUR },
  clientGlobal: { limit: 500, windowSeconds: HOUR },
  approvePerIp: { limit: 10, windowSeconds: HOUR },
  approveGlobal: { limit: 500, windowSeconds: HOUR },
  // Admins are trusted, so this only bounds what a stolen session could do.
  adminPerHour: { limit: 300, windowSeconds: HOUR },
  passPerHour: { limit: 30, windowSeconds: HOUR },
  // A busy service checks every player who joins it.
  redeemPerHour: { limit: 1200, windowSeconds: HOUR },
} as const;

export function registerRules(ipHash: string, tightened = false): Rule[] {
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
    ...(tightened
      ? [
          {
            bucket: "register:tight",
            ...LIMITS.registerTightened,
            label:
              "new bots across the whole site this hour, while registration is tightened after a spike",
          },
        ]
      : []),
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

export function clientRules(ipHash: string): Rule[] {
  return [
    {
      bucket: `client:ip:${ipHash}`,
      ...LIMITS.clientPerIp,
      label: "60 connector clients an hour from one address",
    },
    {
      bucket: "client:all",
      ...LIMITS.clientGlobal,
      label: "connector clients across the whole site this hour",
    },
  ];
}

export function approveRules(ipHash: string): Rule[] {
  return [
    {
      bucket: `approve:ip:${ipHash}`,
      ...LIMITS.approvePerIp,
      label: "10 agents allowed an hour from one address",
    },
    {
      bucket: "approve:all",
      ...LIMITS.approveGlobal,
      label: "agents allowed across the whole site this hour",
    },
  ];
}

export function adminRules(humanId: number): Rule[] {
  return [
    {
      bucket: `admin:${humanId}`,
      ...LIMITS.adminPerHour,
      label: "300 admin changes an hour",
    },
  ];
}

export function passRules(botId: number): Rule[] {
  return [
    {
      bucket: `pass:${botId}`,
      ...LIMITS.passPerHour,
      label: "30 passes an hour",
    },
  ];
}

export function redeemRules(botId: number): Rule[] {
  return [
    {
      bucket: `redeem:${botId}`,
      ...LIMITS.redeemPerHour,
      label: "1200 passes redeemed an hour",
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
      // The refusal rolls back with its transaction, so the database keeps
      // no trace of it; this line in the server log is the only record.
      // Buckets name a bot or human id or an address hash, never an address.
      console.warn(
        JSON.stringify({
          event: "rate_limited",
          rule: r.label,
          bucket: r.bucket,
        }),
      );
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
  await db()`DELETE FROM passes WHERE expires_at < now() - interval '1 day'`;
}
