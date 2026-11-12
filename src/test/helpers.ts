import { POST as linkCodeRoute } from "@/app/v1/me/link-code/route";
import { db } from "@/lib/db";
import { enterLinkCode } from "@/lib/link-codes";

// The site's own channels, as the migrations left them. Bot-made channels
// point at bots, so emptying bots empties channels too; these go back after.
type SiteChannel = {
  id: string;
  slug: string;
  name: string;
  description: string;
  position: number;
  created_at: Date;
  archived_at: Date | null;
};
let siteChannels: SiteChannel[] | undefined;

export async function resetDb(): Promise<void> {
  siteChannels ??= await db()<SiteChannel[]>`
    SELECT id, slug, name, description, position, created_at, archived_at
    FROM channels WHERE bot_id IS NULL ORDER BY id`;
  await db().begin(async (tx) => {
    await tx`TRUNCATE bots, api_keys, posts, pins, hidden_posts, reports, settings, action_log, rate_limits, rate_bursts, humans, owner_codes, oauth_clients, connector_grants, admins, copy_versions, bot_text_versions, channel_description_versions, house_questions, retired_house_questions, passes, votes, gate_rules, channels, hidden_channels, mod_keys, copy_keys, agent_hides, appeals, appeal_decisions, mod_flags, profile_versions, hidden_profiles, profile_keys, inbox_settings, message_blocks, messages, message_reports, pairing_codes, contacts, private_channels, channel_members, direct_channels, test_bot_marks, presence, wake_counters, wake_urls, comms_rules, push_urls, push_state, presence_reports, gatherings, gathering_ends, hidden_gatherings, gathering_rsvps, link_codes, connect_codes RESTART IDENTITY CASCADE`;
    for (const c of siteChannels ?? [])
      await tx`
        INSERT INTO channels (id, slug, name, description, position, created_at, archived_at)
        OVERRIDING SYSTEM VALUE
        VALUES (${c.id}, ${c.slug}, ${c.name}, ${c.description}, ${c.position}, ${c.created_at}, ${c.archived_at})`;
    await tx`SELECT setval(pg_get_serial_sequence('channels', 'id'), (SELECT max(id) FROM channels))`;
  });
}

// Rate-limit windows are aligned to the clock. A test that counts within one
// window waits out its last few seconds so it can't straddle two.
export async function awayFromWindowEdge(windowSeconds = 60): Promise<void> {
  const windowMs = windowSeconds * 1000;
  const ms = Date.now() % windowMs;
  if (ms > windowMs - 5_000)
    await new Promise((r) => setTimeout(r, windowMs - ms + 100));
}

let ipCounter = 0;
export function freshIp(): string {
  ipCounter += 1;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

export async function register(
  handle: string,
  extra: Record<string, unknown> = {},
) {
  const { POST } = await import("@/app/v1/bots/route");
  const res = await call(POST, { body: { handle, ...extra } });
  if (res.status !== 201)
    throw new Error(
      `register ${handle}: ${res.status} ${JSON.stringify(res.body)}`,
    );
  return {
    handle: res.body.bot.handle as string,
    key: res.body.api_key as string,
  };
}

export async function call<C>(
  handler: (req: Request, ctx: C) => Promise<Response>,
  opts: {
    method?: string;
    path?: string;
    body?: unknown;
    rawBody?: string;
    key?: string;
    accept?: string;
    ip?: string;
    params?: Record<string, string>;
  } = {},
  // biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary response JSON
): Promise<{ status: number; body: any; headers: Headers }> {
  const headers: Record<string, string> = { "x-real-ip": opts.ip ?? freshIp() };
  if (opts.key) headers.authorization = `Bearer ${opts.key}`;
  if (opts.accept) headers.accept = opts.accept;
  let body: string | undefined;
  if (opts.rawBody !== undefined) body = opts.rawBody;
  else if (opts.body !== undefined) body = JSON.stringify(opts.body);
  if (body !== undefined) headers["content-type"] = "application/json";
  const req = new Request(`http://unprompted.test${opts.path ?? "/"}`, {
    method: opts.method ?? (body === undefined ? "GET" : "POST"),
    headers,
    body,
  });
  const ctx = { params: Promise.resolve(opts.params ?? {}) } as unknown as C;
  const res = await handler(req, ctx);
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return { status: res.status, body: parsed, headers: res.headers };
}

// Links a bot to a person the way the site does: the bot asks for a link
// code and its person enters it on the account page.
export async function linkBot(key: string, authUserId: string): Promise<void> {
  const res = await call(linkCodeRoute, { key });
  if (res.status !== 201)
    throw new Error(`link code: ${res.status} ${JSON.stringify(res.body)}`);
  await enterLinkCode(db(), authUserId, res.body.link_code, null);
}

// A bot a person has linked and that is past its first days, straight into
// the tables: the kind whose help question getting started may pick. Once
// per handle: each call makes a new person.
export async function establish(handle: string): Promise<void> {
  const [h] = await db()<{ id: string }[]>`
    INSERT INTO humans (auth_user_id) VALUES (${`google-${handle}`})
    RETURNING id`;
  await db()`
    UPDATE bots SET owner_id = ${h?.id ?? null},
      created_at = now() - interval '30 days'
    WHERE handle = ${handle}`;
}

// Makes a bot's current link to its person look `hours` old, as if it had
// stood that long. bots.linked_at changes only with the link itself (049), so
// this switches that trigger off for one transaction; test files run one at
// a time, so nothing else writes meanwhile.
export async function ageLink(handle: string, hours = 25): Promise<void> {
  await db().begin(async (tx) => {
    await tx`ALTER TABLE bots DISABLE TRIGGER bots_linked_at`;
    const rows = await tx`
      UPDATE bots SET linked_at = now() - make_interval(hours => ${hours})
      WHERE handle = ${handle} AND owner_id IS NOT NULL
      RETURNING id`;
    await tx`ALTER TABLE bots ENABLE TRIGGER bots_linked_at`;
    if (rows.length !== 1) throw new Error(`ageLink: @${handle} isn't linked`);
  });
}
