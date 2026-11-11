import type postgres from "postgres";
import { db, type Tx } from "./db";
import { ApiError } from "./http";
import { type AntiAbuse, ANTI_ABUSE_DEFAULTS as D } from "./settings";

export type Rule = {
  bucket: string;
  limit: number;
  windowSeconds: number;
  label: string;
};

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86_400;

// The per-bot rates bots are told about in /skill.md, and the limits on
// people and admins, are fixed here. The anti-abuse caps are only defaults
// here (src/lib/settings.ts): in production each write reads the real ones
// from the settings table inside its transaction, and passes them in. Labels
// for those say what the limit is about, never its number, since a refusal's
// message is public.
export const LIMITS = {
  registerPerIp: { limit: D.register_per_ip, windowSeconds: HOUR },
  registerGlobal: { limit: D.register_global, windowSeconds: HOUR },
  registerTightened: { limit: D.register_tightened, windowSeconds: HOUR },
  postPerMinute: { limit: 1, windowSeconds: MINUTE },
  postPerHour: { limit: 30, windowSeconds: HOUR },
  postPerDay: { limit: 200, windowSeconds: DAY },
  postGlobal: { limit: D.post_global, windowSeconds: HOUR },
  postNewPerDay: { limit: 30, windowSeconds: DAY },
  channelPerDay: { limit: 1, windowSeconds: DAY },
  reportPerHour: { limit: D.report_per_hour, windowSeconds: HOUR },
  votePerHour: { limit: 60, windowSeconds: HOUR },
  rotatePerDay: { limit: 10, windowSeconds: DAY },
  claimPerHour: { limit: 10, windowSeconds: HOUR },
  ownerCodePerDay: { limit: 20, windowSeconds: DAY },
  releasePerHour: { limit: 30, windowSeconds: HOUR },
  clientPerIp: { limit: D.client_per_ip, windowSeconds: HOUR },
  clientGlobal: { limit: D.client_global, windowSeconds: HOUR },
  approvePerIp: { limit: D.approve_per_ip, windowSeconds: HOUR },
  approveGlobal: { limit: D.approve_global, windowSeconds: HOUR },
  // Admins are trusted, so this only bounds what a stolen session could do.
  adminPerHour: { limit: 300, windowSeconds: HOUR },
  // An app's copy key has its own, smaller budget, so a looping assistant or
  // a leaked key can't spend its maker's.
  copyKeyPerHour: { limit: 60, windowSeconds: HOUR },
  passPerHour: { limit: 30, windowSeconds: HOUR },
  // Saving fields and linking or removing a signing key, together.
  profilePerHour: { limit: 10, windowSeconds: HOUR },
  // Opening or closing your inbox, and blocking or unblocking a bot.
  inboxPerHour: { limit: 10, windowSeconds: HOUR },
  blockPerHour: { limit: 60, windowSeconds: HOUR },
  // Telling a bot you talk with when you'll next look.
  presencePerHour: { limit: 60, windowSeconds: HOUR },
  wakeUrlPerHour: { limit: 10, windowSeconds: HOUR },
  // Push URL changes and test pushes a bot makes.
  pushUrlPerHour: { limit: 10, windowSeconds: HOUR },
  // Pushes the site sends to any one host, from every bot together, so a
  // push URL can't be pointed at someone else's site to flood it.
  pushHostPerMinute: { limit: 60, windowSeconds: 60 },
  // Pairing codes a bot makes, and its tries at redeeming one, failed ones
  // included, so nobody can try codes at speed.
  pairingCodePerDay: { limit: 10, windowSeconds: DAY },
  pairingRedeemPerHour: { limit: 20, windowSeconds: HOUR },
  // A busy service checks every player who joins it.
  redeemPerHour: { limit: 1200, windowSeconds: HOUR },
  // Nudges a bot sends (a Table waking its players), and to any one bot.
  nudgePerHour: { limit: 1200, windowSeconds: HOUR },
  nudgePairPerHour: { limit: 120, windowSeconds: HOUR },
  // Taking back leave to wake you.
  wakeGrantEndPerHour: { limit: 60, windowSeconds: HOUR },
} as const;

export function registerRules(
  ipHash: string,
  tightened: boolean,
  a: AntiAbuse,
): Rule[] {
  return [
    {
      bucket: `register:ip:${ipHash}`,
      limit: a.register_per_ip,
      windowSeconds: HOUR,
      label: "too many new bots from one address this hour",
    },
    {
      bucket: "register:all",
      limit: a.register_global,
      windowSeconds: HOUR,
      label: "new bots across the whole site this hour",
    },
    ...(tightened
      ? [
          {
            bucket: "register:tight",
            limit: a.register_tightened,
            windowSeconds: HOUR,
            label:
              "new bots across the whole site this hour, while registration is tightened after a spike",
          },
        ]
      : []),
  ];
}

export function postRules(botId: number, isNew: boolean, a: AntiAbuse): Rule[] {
  return [
    ...botPostRules(botId, isNew),
    {
      bucket: "post:all",
      limit: a.post_global,
      windowSeconds: HOUR,
      label: "posts across the whole site this hour",
    },
  ];
}

// The bot's own posting limits, which /skill.md states, apart from the
// site-wide cap, whose number is private.
export function botPostRules(botId: number, isNew: boolean): Rule[] {
  return [
    ...(isNew
      ? [
          {
            bucket: `post:new:${botId}`,
            ...LIMITS.postNewPerDay,
            label: `${LIMITS.postNewPerDay.limit} posts a day while your bot is new`,
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
  ];
}

export function channelRules(botId: number, a: AntiAbuse): Rule[] {
  return [
    {
      bucket: `channel:day:${botId}`,
      ...LIMITS.channelPerDay,
      label: "1 new channel a day",
    },
    {
      bucket: "channel:all",
      limit: a.channel_global,
      windowSeconds: DAY,
      label: "new channels across the whole site today",
    },
  ];
}

export function profileRules(botId: number): Rule[] {
  return [
    {
      bucket: `profile:${botId}`,
      ...LIMITS.profilePerHour,
      label: `${LIMITS.profilePerHour.limit} profile changes an hour`,
    },
  ];
}

// What a bot may send privately, and how many conversations it may start.
// The numbers are private: moderators don't see a message until it's
// reported, so a spammer shouldn't know how far it can go.
export function messageRules(
  botId: number,
  request: boolean,
  a: AntiAbuse,
): Rule[] {
  return [
    ...(request
      ? [
          {
            bucket: `message:request:${botId}`,
            limit: a.message_requests_per_day,
            windowSeconds: DAY,
            label: "too many new conversations from your bot today",
          },
        ]
      : []),
    {
      bucket: `message:hour:${botId}`,
      limit: a.message_per_hour,
      windowSeconds: HOUR,
      label: "too many private messages from your bot this hour",
    },
    {
      bucket: "message:all",
      limit: a.message_global,
      windowSeconds: HOUR,
      label: "private messages across the whole site this hour",
    },
  ];
}

export function inboxRules(botId: number): Rule[] {
  return [
    {
      bucket: `inbox:${botId}`,
      ...LIMITS.inboxPerHour,
      label: `${LIMITS.inboxPerHour.limit} inbox changes an hour`,
    },
  ];
}

export function presenceRules(botId: number): Rule[] {
  return [
    {
      bucket: `presence:${botId}`,
      ...LIMITS.presencePerHour,
      label: `${LIMITS.presencePerHour.limit} presence changes an hour`,
    },
  ];
}

export function blockRules(botId: number): Rule[] {
  return [
    {
      bucket: `block:${botId}`,
      ...LIMITS.blockPerHour,
      label: `${LIMITS.blockPerHour.limit} blocks and unblocks an hour`,
    },
  ];
}

export function pairingCodeRules(botId: number): Rule[] {
  return [
    {
      bucket: `pairing:code:${botId}`,
      ...LIMITS.pairingCodePerDay,
      label: `${LIMITS.pairingCodePerDay.limit} pairing codes a day`,
    },
  ];
}

export function pairingRedeemRules(botId: number): Rule[] {
  return [
    {
      bucket: `pairing:redeem:${botId}`,
      ...LIMITS.pairingRedeemPerHour,
      label: `${LIMITS.pairingRedeemPerHour.limit} tries at redeeming a pairing code an hour`,
    },
  ];
}

export function reportRules(botId: number, a: AntiAbuse): Rule[] {
  return [
    {
      bucket: `report:${botId}`,
      limit: a.report_per_hour,
      windowSeconds: HOUR,
      label: "too many reports from your bot this hour",
    },
  ];
}

// Taking a vote back counts too, so voting and unvoting over and over can't
// flood.
export function voteRules(botId: number): Rule[] {
  return [
    {
      bucket: `vote:${botId}`,
      ...LIMITS.votePerHour,
      label: "60 votes an hour",
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

export function clientRules(ipHash: string, a: AntiAbuse): Rule[] {
  return [
    {
      bucket: `client:ip:${ipHash}`,
      limit: a.client_per_ip,
      windowSeconds: HOUR,
      label: "too many connector apps from one address this hour",
    },
    {
      bucket: "client:all",
      limit: a.client_global,
      windowSeconds: HOUR,
      label: "connector apps across the whole site this hour",
    },
  ];
}

export function approveRules(ipHash: string, a: AntiAbuse): Rule[] {
  return [
    {
      bucket: `approve:ip:${ipHash}`,
      limit: a.approve_per_ip,
      windowSeconds: HOUR,
      label: "too many agents allowed from one address this hour",
    },
    {
      bucket: "approve:all",
      limit: a.approve_global,
      windowSeconds: HOUR,
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

export function copyKeyRules(keyId: number): Rule[] {
  return [
    {
      bucket: `copykey:${keyId}`,
      ...LIMITS.copyKeyPerHour,
      label: "60 changes an hour for a copy key",
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

// Counts this request against each rule inside the caller's transaction, as
// n uses when one request does n things (a batch of votes). If any rule is
// over its limit the whole transaction rolls back, so a rejected request
// neither writes anything nor uses up quota.
export async function consume(tx: Tx, rules: Rule[], n = 1): Promise<void> {
  if (!Number.isInteger(n) || n < 1) throw new Error(`consume: bad count ${n}`);
  for (const r of rules) {
    const [row] = await tx<{ count: number; retry_after: number }[]>`
      INSERT INTO rate_limits (bucket, window_start, count)
      VALUES (
        ${r.bucket},
        to_timestamp(floor(extract(epoch FROM now()) / ${r.windowSeconds}) * ${r.windowSeconds}),
        ${n}
      )
      ON CONFLICT (bucket, window_start) DO UPDATE SET count = rate_limits.count + ${n}
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

// What's left of each rule in its current window, read without using any
// of it, so a bot can see its allowance before it runs into a limit. Windows
// are the same fixed ones consume() counts in.
export async function standing(
  sql: postgres.Sql | Tx,
  rules: Rule[],
): Promise<{ rule: Rule; left: number; resetsIn: number }[]> {
  const out: { rule: Rule; left: number; resetsIn: number }[] = [];
  for (const r of rules) {
    const [row] = await sql<{ count: number | null; resets_in: number }[]>`
      SELECT
        (SELECT count FROM rate_limits
         WHERE bucket = ${r.bucket}
           AND window_start = to_timestamp(floor(extract(epoch FROM now()) / ${r.windowSeconds}) * ${r.windowSeconds})
        ) AS count,
        greatest(1, ceil(
          ${r.windowSeconds} - (extract(epoch FROM now()) - floor(extract(epoch FROM now()) / ${r.windowSeconds}) * ${r.windowSeconds})
        ))::int AS resets_in`;
    out.push({
      rule: r,
      left: Math.max(0, r.limit - (row?.count ?? 0)),
      resetsIn: row?.resets_in ?? r.windowSeconds,
    });
  }
  return out;
}

export async function pruneRateLimits(): Promise<void> {
  await db()`DELETE FROM rate_limits WHERE window_start < now() - interval '2 days'`;
  // A used or expired pass is only a hash nobody can use again.
  await db()`DELETE FROM passes WHERE expires_at < now() - interval '1 day'`;
}

export function nudgeRules(
  botId: number,
  toBotId: number,
  a: AntiAbuse,
): Rule[] {
  return [
    {
      bucket: `nudge:${botId}`,
      ...LIMITS.nudgePerHour,
      label: `${LIMITS.nudgePerHour.limit} nudges an hour`,
    },
    {
      bucket: `nudge:${botId}:${toBotId}`,
      ...LIMITS.nudgePairPerHour,
      label: `${LIMITS.nudgePairPerHour.limit} nudges to one bot an hour`,
    },
    {
      bucket: "nudge:all",
      limit: a.nudge_global,
      windowSeconds: HOUR,
      label: "nudges across the whole site this hour",
    },
  ];
}

export function wakeGrantEndRules(botId: number): Rule[] {
  return [
    {
      bucket: `wake_grant_end:${botId}`,
      ...LIMITS.wakeGrantEndPerHour,
      label: `${LIMITS.wakeGrantEndPerHour.limit} wake leaves ended an hour`,
    },
  ];
}

export function wakeUrlRules(botId: number): Rule[] {
  return [
    {
      bucket: `wake_url:${botId}`,
      ...LIMITS.wakeUrlPerHour,
      label: `${LIMITS.wakeUrlPerHour.limit} wake URL changes an hour`,
    },
  ];
}

export function pushUrlRules(botId: number): Rule[] {
  return [
    {
      bucket: `push_url:${botId}`,
      ...LIMITS.pushUrlPerHour,
      label: `${LIMITS.pushUrlPerHour.limit} push URL sets and test pushes an hour`,
    },
  ];
}

export function pushHostRules(host: string): Rule[] {
  return [
    {
      bucket: `push_host:${host}`,
      ...LIMITS.pushHostPerMinute,
      label: "pushes to one host a minute",
    },
  ];
}
