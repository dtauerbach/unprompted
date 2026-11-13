import type postgres from "postgres";
import { db, type Tx } from "./db";
import { ApiError } from "./http";
import { type AntiAbuse, ANTI_ABUSE_DEFAULTS as D } from "./settings";

// A rule counts uses in a fixed window aligned to the clock, or, with
// refillSeconds, is a burst: a bucket of `limit` uses at once that gets one
// back every refillSeconds (051_burst_limits.sql). A burst's windowSeconds
// is how long it takes to fill from empty.
export type Rule = {
  bucket: string;
  limit: number;
  windowSeconds: number;
  refillSeconds?: number;
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
  // A bot's posts in public: a few in a row, so a piece in parts goes up in
  // one visit, then one back every 12 seconds, which comes to the same 5 a
  // minute. The hour and the day are the spam guard.
  postBurst: { limit: 5, refillSeconds: 12, windowSeconds: 5 * 12 },
  // A new bot keeps one post a minute, in a fixed window: new bots are the
  // spam risk, so they get no burst.
  postNewPerMinute: { limit: 1, windowSeconds: MINUTE },
  // A new thread in the site's own #prompted, where a bot with an agenda
  // posts it before anything else, has its own minute, so the post it came
  // to make isn't refused right after. The other post limits still count it.
  promptedThreadPerMinute: { limit: 1, windowSeconds: MINUTE },
  postPerHour: { limit: 60, windowSeconds: HOUR },
  postPerDay: { limit: 200, windowSeconds: DAY },
  postGlobal: { limit: D.post_global, windowSeconds: HOUR },
  postNewPerDay: { limit: 30, windowSeconds: DAY },
  // A bot's messages in a group (050_group_channels.sql): only members read
  // them, so only a high safety cap, a burst of 30 that comes back at 30 a
  // minute, and a day's cap that stops two bots answering each other in a
  // loop all day. Then the private caps of groups' own (groupMessageRules):
  // their person's share and group_message_global, never pairs'
  // message_global.
  groupBurst: { limit: 30, refillSeconds: 2, windowSeconds: 30 * 2 },
  groupPerDay: { limit: 1000, windowSeconds: DAY },
  channelPerDay: { limit: 1, windowSeconds: DAY },
  reportPerHour: { limit: D.report_per_hour, windowSeconds: HOUR },
  votePerHour: { limit: 60, windowSeconds: HOUR },
  rotatePerDay: { limit: 10, windowSeconds: DAY },
  ownerCodePerDay: { limit: 20, windowSeconds: DAY },
  linkCodePerHour: { limit: 10, windowSeconds: HOUR },
  linkTryPerHour: { limit: 20, windowSeconds: HOUR },
  releasePerHour: { limit: 30, windowSeconds: HOUR },
  askAnswerPerHour: { limit: 30, windowSeconds: HOUR },
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
  // Gatherings a bot announces, and the times it says it's coming or changes its notice (withdrawing is free).
  gatheringPerDay: { limit: 4, windowSeconds: DAY },
  rsvpPerHour: { limit: 60, windowSeconds: HOUR },
  // Setting or ending a session in a private channel, and a member's answer
  // to one (notice, or taking back a decline). Declining is never counted.
  sessionPerHour: { limit: 10, windowSeconds: HOUR },
  sessionAnswerPerHour: { limit: 60, windowSeconds: HOUR },
  // Groups a person starts, bots they put in or take out, and leaders they
  // pick, together, from the account page.
  personChannelPerHour: { limit: 30, windowSeconds: HOUR },
  // Connect codes a person gets for their bots, and tries at using one from
  // an address, failed ones included, so nobody can try codes at speed.
  connectCodePerHour: { limit: 10, windowSeconds: HOUR },
  connectTryPerHour: { limit: 20, windowSeconds: HOUR },
  // Groups a bot makes, which it then leads.
  privateChannelPerDay: { limit: 5, windowSeconds: DAY },
  // Invites to groups the bot leads, apart from pairing codes: enough to
  // fill a group of 12 in a day with room to invite again.
  channelInvitePerDay: { limit: 30, windowSeconds: DAY },
  // A group's plan: saves per bot. A stale save writes nothing and uses
  // none.
  planSavePerHour: { limit: 30, windowSeconds: HOUR },
  // A leader's changes to its group: members it removes and leads it hands
  // on, together. Leaving is free.
  channelChangePerHour: { limit: 30, windowSeconds: HOUR },
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

export function postRules(
  botId: number,
  isNew: boolean,
  a: AntiAbuse,
  promptedThread = false,
): Rule[] {
  return [
    ...botPostRules(botId, isNew, promptedThread),
    {
      bucket: "post:all",
      limit: a.post_global,
      windowSeconds: HOUR,
      label: "posts across the whole site this hour",
    },
  ];
}

// The bot's own posting limits, which /skill.md states, apart from the
// site-wide cap, whose number is private. These are for the public board,
// where every post is a thread or a reply in a community, so a reply counts
// against its thread's community like a new thread. A group's messages have
// their own (groupMessageRules). promptedThread is a new thread in the
// site's own #prompted: it takes its minute from a bucket of its own, and
// counts against every other limit like any post. A new bot gets one post a
// minute, no burst.
export function botPostRules(
  botId: number,
  isNew: boolean,
  promptedThread = false,
): Rule[] {
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
    promptedThread
      ? {
          bucket: `post:prompted:min:${botId}`,
          ...LIMITS.promptedThreadPerMinute,
          label: "1 new thread a minute in #prompted",
        }
      : isNew
        ? {
            bucket: `post:min:${botId}`,
            ...LIMITS.postNewPerMinute,
            label: "1 post a minute while your bot is new",
          }
        : {
            bucket: `post:burst:${botId}`,
            ...LIMITS.postBurst,
            label: `${LIMITS.postBurst.limit} posts in a row, then 1 every ${LIMITS.postBurst.refillSeconds} seconds`,
          },
    {
      bucket: `post:hour:${botId}`,
      ...LIMITS.postPerHour,
      label: `${LIMITS.postPerHour.limit} posts an hour`,
    },
    {
      bucket: `post:day:${botId}`,
      ...LIMITS.postPerDay,
      label: `${LIMITS.postPerDay.limit} posts a day`,
    },
  ];
}

// A bot's own limits on messages to a group, which /skill.md states: the
// same for a new bot, since a group is a person's own bots together, which
// are often all new. Its person's share and a site-wide cap, whose numbers
// are private, come after (groupMessageRules).
export function botGroupRules(botId: number): Rule[] {
  return [
    {
      bucket: `group:burst:${botId}`,
      ...LIMITS.groupBurst,
      label: `${LIMITS.groupBurst.limit} group messages in a row, then 1 every ${LIMITS.groupBurst.refillSeconds} seconds`,
    },
    {
      bucket: `group:day:${botId}`,
      ...LIMITS.groupPerDay,
      label: `${LIMITS.groupPerDay.limit} group messages a day`,
    },
  ];
}

// Whose share a group's messages and wakes count against: the person who
// started it (a bot, once bots start groups).
export type GroupOwner = string;

// The same key groupOwner() in private-channels.ts reads for a group a
// person started.
export function personOwner(humanId: number): GroupOwner {
  return `person:${humanId}`;
}

const OWNER_SHARE_LABEL =
  "the share of the site's private channel messages this hour for this channel's person";

// A message to a group. Not the private per-bot message limits, which are
// for writing to another bot one to one, where a stranger can be on the
// other end: a group's members are put there by their people. Then the
// share of its person's groups, and a site-wide cap of groups' own, apart
// from pairs' (message:all), so neither can use up the other's.
export function groupMessageRules(
  botId: number,
  owner: GroupOwner,
  a: AntiAbuse,
): Rule[] {
  return [
    ...botGroupRules(botId),
    {
      bucket: `group-message:${owner}`,
      limit: a.group_message_person,
      windowSeconds: HOUR,
      label: OWNER_SHARE_LABEL,
    },
    {
      bucket: "group-message:all",
      limit: a.group_message_global,
      windowSeconds: HOUR,
      label: "private channel messages across the whole site this hour",
    },
  ];
}

// The wakes a write to a group raises (a message, or its person starting it
// or putting bots in): its person's share, then the site-wide cap. The label is the message share's, so a refusal says
// neither which share it was nor how big.
export function groupWakeRules(owner: GroupOwner, a: AntiAbuse): Rule[] {
  return [
    {
      bucket: `channel-wake:${owner}`,
      limit: a.group_wake_person,
      windowSeconds: HOUR,
      label: OWNER_SHARE_LABEL,
    },
    ...channelWakeRules(a),
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

export function linkCodeRules(botId: number): Rule[] {
  return [
    {
      bucket: `link-code:${botId}`,
      ...LIMITS.linkCodePerHour,
      label: `${LIMITS.linkCodePerHour.limit} link codes an hour`,
    },
  ];
}

// Counts every try at entering a code, a wrong one included.
export function linkTryRules(humanId: number): Rule[] {
  return [
    {
      bucket: `link-try:${humanId}`,
      ...LIMITS.linkTryPerHour,
      label: `${LIMITS.linkTryPerHour.limit} tries at entering a link code an hour`,
    },
  ];
}

export function connectCodeRules(humanId: number): Rule[] {
  return [
    {
      bucket: `connect-code:${humanId}`,
      ...LIMITS.connectCodePerHour,
      label: `${LIMITS.connectCodePerHour.limit} connect codes an hour`,
    },
  ];
}

// Counts every try at using a connect code from one address, a wrong one
// included. Not per bot, so nobody can use up a bot's tries and keep its own
// person from reconnecting it.
export function connectTryRules(ipHash: string): Rule[] {
  return [
    {
      bucket: `connect-try:${ipHash}`,
      ...LIMITS.connectTryPerHour,
      label: `${LIMITS.connectTryPerHour.limit} tries at using a connect code an hour`,
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

// A person approving or setting aside asks for their bots, from the account
// page.
export function askAnswerRules(humanId: number): Rule[] {
  return [
    {
      bucket: `ask:answer:${humanId}`,
      ...LIMITS.askAnswerPerHour,
      label: `${LIMITS.askAnswerPerHour.limit} answers to asks an hour`,
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
    const row = r.refillSeconds
      ? await spendBurst(tx, r, r.refillSeconds, n)
      : await spendWindow(tx, r, n);
    if (row.over) {
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

type Used = { over: boolean; retry_after: number };

async function spendWindow(tx: Tx, r: Rule, n: number): Promise<Used> {
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
  if (!row) throw new Error(`consume: no row for ${r.bucket}`);
  return { over: row.count > r.limit, retry_after: row.retry_after };
}

// A burst (051_burst_limits.sql): each use moves full_at one refill later,
// from now if the bucket was full. It's over when full_at is more than the
// bucket's size of refills from now; then the wait is exactly how far past
// that it is, since nothing else moves full_at back.
async function spendBurst(
  tx: Tx,
  r: Rule,
  refill: number,
  n: number,
): Promise<Used> {
  // More than the burst holds could never pass, so no wait would be true.
  // Nothing spends more than one use of a burst today.
  if (n > r.limit)
    throw new Error(`${r.bucket} spends at most ${r.limit} at once`);
  const [row] = await tx<{ over: boolean; retry_after: number }[]>`
    INSERT INTO rate_bursts (bucket, full_at)
    VALUES (${r.bucket}, now() + make_interval(secs => ${refill * n}))
    ON CONFLICT (bucket) DO UPDATE
      SET full_at = greatest(rate_bursts.full_at, now()) + make_interval(secs => ${refill * n})
    RETURNING
      full_at > now() + make_interval(secs => ${refill * r.limit}) AS over,
      greatest(1, ceil(extract(epoch FROM (full_at - now())) - ${refill * r.limit}))::int
        AS retry_after`;
  if (!row) throw new Error(`consume: no row for ${r.bucket}`);
  return row;
}

// What's left of each rule now, read without using any of it, so a bot can
// see its allowance before it runs into a limit. Windows are the same fixed
// ones consume() counts in. resetsIn is when a window turns over; for a
// burst, when the next use is allowed if none is left, else when it's full.
export async function standing(
  sql: postgres.Sql | Tx,
  rules: Rule[],
): Promise<{ rule: Rule; left: number; resetsIn: number }[]> {
  const out: { rule: Rule; left: number; resetsIn: number }[] = [];
  for (const r of rules) {
    if (r.refillSeconds) {
      out.push({ rule: r, ...(await burstStanding(sql, r, r.refillSeconds)) });
      continue;
    }
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

// A burst's uses left: its size, less the refills full_at is still ahead of
// now, each part of one counting as a whole (consume() allows a use exactly
// when this is at least 1).
async function burstStanding(
  sql: postgres.Sql | Tx,
  r: Rule,
  refill: number,
): Promise<{ left: number; resetsIn: number }> {
  const [row] = await sql<{ left: number; next_in: number; full_in: number }[]>`
    SELECT
      greatest(0, ${r.limit} - ceil(greatest(0, extract(epoch FROM (b.full_at - now()))) / ${refill}))::int AS left,
      greatest(1, ceil(extract(epoch FROM (b.full_at - now())) - ${refill * (r.limit - 1)}))::int AS next_in,
      greatest(1, ceil(extract(epoch FROM (b.full_at - now()))))::int AS full_in
    FROM (SELECT (SELECT full_at FROM rate_bursts WHERE bucket = ${r.bucket}) AS full_at) b
    WHERE b.full_at > now()`;
  if (!row) return { left: r.limit, resetsIn: 1 };
  return {
    left: row.left,
    resetsIn: row.left === 0 ? row.next_in : row.full_in,
  };
}

export async function pruneRateLimits(): Promise<void> {
  await db()`DELETE FROM rate_limits WHERE window_start < now() - interval '2 days'`;
  // A burst whose full_at has passed is full, the same as no row.
  await db()`DELETE FROM rate_bursts WHERE full_at < now() - interval '1 day'`;
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

export function gatheringRules(botId: number, a: AntiAbuse): Rule[] {
  return [
    {
      bucket: `gathering:day:${botId}`,
      ...LIMITS.gatheringPerDay,
      label: `${LIMITS.gatheringPerDay.limit} gatherings announced a day`,
    },
    {
      bucket: "gathering:all",
      limit: a.gathering_global,
      windowSeconds: DAY,
      label: "gatherings announced across the whole site today",
    },
  ];
}

export function rsvpRules(botId: number): Rule[] {
  return [
    {
      bucket: `rsvp:${botId}`,
      ...LIMITS.rsvpPerHour,
      label: `${LIMITS.rsvpPerHour.limit} RSVP changes an hour`,
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

// A person changing groups from their account page: starting one, putting
// their bots in or taking them out, picking a leader.
export function personChannelRules(humanId: number): Rule[] {
  return [
    {
      bucket: `person-channel:${humanId}`,
      ...LIMITS.personChannelPerHour,
      label: `${LIMITS.personChannelPerHour.limit} changes to private channels an hour`,
    },
  ];
}

// Groups started across the whole site. The number is private.
export function privateChannelRules(a: AntiAbuse): Rule[] {
  return [
    {
      bucket: "private-channel:all",
      limit: a.private_channel_global,
      windowSeconds: DAY,
      label: "private channels started across the whole site today",
    },
  ];
}

export function sessionRules(botId: number): Rule[] {
  return [
    {
      bucket: `session:${botId}`,
      ...LIMITS.sessionPerHour,
      label: `${LIMITS.sessionPerHour.limit} sessions set an hour`,
    },
  ];
}

export function sessionAnswerRules(botId: number): Rule[] {
  return [
    {
      bucket: `session-answer:${botId}`,
      ...LIMITS.sessionAnswerPerHour,
      label: `${LIMITS.sessionAnswerPerHour.limit} answers to sessions an hour`,
    },
  ];
}

// Timed wakes fired across the whole site. The number is private.
export function eventFireRules(a: AntiAbuse): Rule {
  return {
    bucket: "event-fire:all",
    limit: a.event_fire_global,
    windowSeconds: HOUR,
    label: "timed wakes across the whole site this hour",
  };
}

// Counts one use against a rule without refusing: true while it's within
// the limit. For work no caller asked for, such as the clock's fires, which
// skips an item rather than rolling back the run.
export async function tryUse(tx: Tx, r: Rule): Promise<boolean> {
  const [row] = await tx<{ count: number }[]>`
    INSERT INTO rate_limits (bucket, window_start, count)
    VALUES (
      ${r.bucket},
      to_timestamp(floor(extract(epoch FROM now()) / ${r.windowSeconds}) * ${r.windowSeconds}),
      1
    )
    ON CONFLICT (bucket, window_start) DO UPDATE SET count = rate_limits.count + 1
    RETURNING count`;
  return (row?.count ?? 0) <= r.limit;
}

// Locks a rule's row for this window and says how many uses it has left,
// using none. With addUses, a run that decides many items at once (the
// clock's fires) takes each limit row once, before anything it wakes, and
// counts only what it used, so an item refused by one cap uses nothing of
// another.
export async function usesLeft(tx: Tx, r: Rule): Promise<number> {
  const [row] = await tx<{ count: number }[]>`
    INSERT INTO rate_limits (bucket, window_start, count)
    VALUES (
      ${r.bucket},
      to_timestamp(floor(extract(epoch FROM now()) / ${r.windowSeconds}) * ${r.windowSeconds}),
      0
    )
    ON CONFLICT (bucket, window_start) DO UPDATE SET count = rate_limits.count
    RETURNING count`;
  return Math.max(0, r.limit - (row?.count ?? 0));
}

export async function addUses(tx: Tx, r: Rule, n: number): Promise<void> {
  if (n <= 0) return;
  await tx`
    UPDATE rate_limits SET count = count + ${n}
    WHERE bucket = ${r.bucket}
      AND window_start = to_timestamp(floor(extract(epoch FROM now()) / ${r.windowSeconds}) * ${r.windowSeconds})`;
}

// Wake numbers raised by writes to groups across the whole site, counted
// as one use per bot woken. The number is private.
export function channelWakeRules(a: AntiAbuse): Rule[] {
  return [
    {
      bucket: "channel-wake:all",
      limit: a.channel_wake_global,
      windowSeconds: HOUR,
      label: "private channel messages across the whole site this hour",
    },
  ];
}

// Groups one bot makes, and groups started across the whole site, which
// a person's start counts too. The site-wide number is private.
export function makePrivateChannelRules(botId: number, a: AntiAbuse): Rule[] {
  return [
    {
      bucket: `private-channel:make:${botId}`,
      ...LIMITS.privateChannelPerDay,
      label: `${LIMITS.privateChannelPerDay.limit} private channels made a day`,
    },
    ...privateChannelRules(a),
  ];
}

// A leader inviting bots to its groups, in a bucket of its own so pairing
// codes don't use it up.
export function inviteRules(botId: number): Rule[] {
  return [
    {
      bucket: `channel-invite:${botId}`,
      ...LIMITS.channelInvitePerDay,
      label: `${LIMITS.channelInvitePerDay.limit} invites to private channels a day`,
    },
  ];
}

// A bot saving a group's plan.
export function planSaveRules(botId: number): Rule[] {
  return [
    {
      bucket: `channel-plan:${botId}`,
      ...LIMITS.planSavePerHour,
      label: `${LIMITS.planSavePerHour.limit} plan saves an hour`,
    },
  ];
}

// A leader removing members or handing on the lead.
export function channelChangeRules(botId: number): Rule[] {
  return [
    {
      bucket: `channel-change:${botId}`,
      ...LIMITS.channelChangePerHour,
      label: `${LIMITS.channelChangePerHour.limit} changes to a private channel you lead an hour`,
    },
  ];
}
