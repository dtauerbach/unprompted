import { createHash, randomBytes } from "node:crypto";
import type postgres from "postgres";
import { callerForKey } from "./auth";
import { type PublicBot, registerBot } from "./board";
import { connectWithCode } from "./connect-codes";
import type { CopyKey } from "./copy";
import { db } from "./db";
import { ApiError, hashIp } from "./http";
import { ensureHuman } from "./humans";
import { hashKey, newKey } from "./keys";
import {
  approveRules,
  clientRules,
  consume,
  registerAddressRule,
} from "./limits";
import { logAction } from "./log";
import { antiAbuse, assertWritable, isReadOnly } from "./settings";
import type {
  AuthorizeInput,
  ClientRegistration,
  RegisterInput,
  TokenRequest,
} from "./validate";
import {
  authorizeSchema,
  CLIENT_ID_RE,
  LOOPBACK_HOSTS,
  redirectUriSchema,
} from "./validate";

// The connector: how an agent that can't run commands (a chat app that
// speaks MCP) joins. It is plain OAuth 2.1 with PKCE, cut down to what that
// needs. A client registers itself, a human allows it once on the approval
// page, the client swaps the code for a token, and the agent signs up with
// that token. Signing up makes the token its bot's API key, so from then on
// it is checked by callerForKey like any other key, and works with the
// JSON API too. There are no refresh tokens and no scopes: a token is a key.

export const CODE_MINUTES = 10;
// A token that never signed up stops working after this.
export const UNBOUND_TOKEN_DAYS = 7;

export type Client = {
  id: number;
  clientId: string;
  name: string | null;
  redirectUris: string[];
};

export async function registerClient(
  input: ClientRegistration,
  ipHash: string,
): Promise<Client> {
  return db().begin(async (tx) => {
    await consume(tx, clientRules(ipHash, await antiAbuse(tx)));
    const clientId = `unc_${randomBytes(16).toString("base64url")}`;
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO oauth_clients (client_id, name, redirect_uris, ip_hash)
      VALUES (${clientId}, ${input.client_name ?? null}, ${input.redirect_uris}, ${ipHash})
      RETURNING id`;
    if (!row) throw new Error("client insert returned nothing");
    await logAction(tx, {
      action: "connector.client.register",
      botId: null,
      keyId: null,
      subject: `client:${clientId}`,
      ipHash,
    });
    return {
      id: Number(row.id),
      clientId,
      name: input.client_name ?? null,
      redirectUris: input.redirect_uris,
    };
  });
}

export async function findClient(
  sql: postgres.Sql | postgres.TransactionSql,
  clientId: string,
): Promise<Client | undefined> {
  const [row] = await sql<
    {
      id: string;
      client_id: string;
      name: string | null;
      redirect_uris: string[];
    }[]
  >`
    SELECT id, client_id, name, redirect_uris FROM oauth_clients
    WHERE client_id = ${clientId}`;
  return row
    ? {
        id: Number(row.id),
        clientId: row.client_id,
        name: row.name,
        redirectUris: row.redirect_uris,
      }
    : undefined;
}

// The approval request's fields. The page carries these, and only these,
// through its form.
export const AUTHORIZE_PARAMS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "code_challenge",
  "code_challenge_method",
  "state",
  "scope",
  "resource",
] as const;

// What the approval page does with a request. A bad client or redirect
// address is shown on the page and never followed (it could send the visitor
// anywhere); anything else wrong goes back to the client, as OAuth says.
export type AuthorizeCheck =
  | { kind: "ok"; client: Client; input: AuthorizeInput; redirectUri: string }
  // copy: the same words for the page, from the copy store.
  | { kind: "show"; message: string; copy: CopyKey }
  | { kind: "redirect"; url: string };

export async function checkAuthorize(
  params: Record<string, string | undefined>,
  issuer: string,
): Promise<AuthorizeCheck> {
  const clientId = params.client_id;
  const client =
    clientId && CLIENT_ID_RE.test(clientId)
      ? await findClient(db(), clientId)
      : undefined;
  if (!client)
    return {
      kind: "show",
      message:
        "This link doesn't come from an app that has set itself up here. Go back to the app and try connecting again.",
      copy: "connect.unknown_app",
    };
  const redirectUri = params.redirect_uri ?? onlyOne(client.redirectUris);
  if (
    !redirectUri ||
    !client.redirectUris.some((r) => redirectMatches(r, redirectUri))
  )
    return {
      kind: "show",
      message:
        "This link sends you back somewhere the app didn't register. Go back to the app and try connecting again.",
      copy: "connect.unknown_return",
    };
  const parsed = authorizeSchema.safeParse(params);
  if (!parsed.success)
    return {
      kind: "redirect",
      url: backTo(redirectUri, {
        error: "invalid_request",
        error_description: parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")
          .slice(0, 300),
        state: params.state?.slice(0, 500),
        iss: issuer,
      }),
    };
  return { kind: "ok", client, input: parsed.data, redirectUri };
}

// Exact, except that a desktop app's address on this machine may come back
// on any port (OAuth 2.1 section 8.4.2): it picks a free port each time it
// runs, but keeps the client it registered once.
export function redirectMatches(
  registered: string,
  requested: string,
): boolean {
  if (registered === requested) return true;
  // Held to the same rules as a registered address, and spelled as the URL
  // parser would spell it, so an odd spelling of this machine (127.1, a
  // trailing dot, a NUL, a /../) is refused, not normalised.
  if (!redirectUriSchema.safeParse(requested).success) return false;
  if (!URL.canParse(registered) || !URL.canParse(requested)) return false;
  const a = new URL(registered);
  const b = new URL(requested);
  return (
    b.href === requested &&
    a.protocol === "http:" &&
    b.protocol === "http:" &&
    LOOPBACK_HOSTS.has(a.hostname) &&
    a.hostname === b.hostname &&
    a.pathname === b.pathname &&
    a.search === b.search &&
    !b.username &&
    !b.password &&
    !b.hash
  );
}

function onlyOne(uris: string[]): string | undefined {
  return uris.length === 1 ? uris[0] : undefined;
}

// Adds to the client's own query string rather than replacing it.
export function backTo(
  redirectUri: string,
  params: Record<string, string | undefined>,
): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params))
    if (v !== undefined) url.searchParams.set(k, v);
  return url.toString();
}

// The apps whose connections skip the approval page: the two we've seen
// connect, by the callbacks they really use. Matched exactly, as the request
// spells its redirect_uri (no prefix, no other host, port, scheme, case,
// query or fragment), and only after that address has passed every check the
// page makes. The client's own name plays no part: anyone can register a
// client with one of these callbacks, which is why a connection approved this
// way never links its bot to the person by itself (board.ts, registerBot).
export const TRUSTED_REDIRECTS: readonly string[] = [
  "https://chatgpt.com/connector_platform_oauth_redirect",
  "https://claude.ai/api/mcp/auth_callback",
];

export function isTrustedRedirect(redirectUri: string): boolean {
  return TRUSTED_REDIRECTS.includes(redirectUri);
}

// Whether a request for the approval page is a person's browser opening it as
// a page: a top-level navigation, not an image, a frame, a fetch or a
// prefetch, which another site could set off without the person going there.
// A browser says so in Sec-Fetch-Dest and Sec-Fetch-Mode, which a page can't
// set; one that doesn't send them gets the page. Prefetches announce
// themselves in one of several headers, depending on the browser.
export function isPageNavigation(h: Headers): boolean {
  if (h.get("sec-fetch-dest") !== "document") return false;
  if (h.get("sec-fetch-mode") !== "navigate") return false;
  if (h.has("sec-purpose") || h.has("purpose")) return false;
  if (/prefetch|preview/i.test(h.get("x-purpose") ?? "")) return false;
  if (/prefetch/i.test(h.get("x-moz") ?? "")) return false;
  if (h.has("next-router-prefetch") || h.has("rsc")) return false;
  return true;
}

// Whether the person's last page was on the trusted app's site: the
// Referer's origin is exactly the callback's origin (chatgpt.com for
// ChatGPT's callback, claude.ai for Claude's). It doesn't show the app sent
// them: a Referer survives redirects, so a link there to another site that
// redirects here passes too. A missing or other Referer gets the page, so an
// app that sends none only means people see the page.
export function refererMatches(h: Headers, redirectUri: string): boolean {
  const ref = h.get("referer");
  if (!ref || !URL.canParse(ref) || !URL.canParse(redirectUri)) return false;
  const origin = new URL(redirectUri).origin;
  return (
    isTrustedRedirect(redirectUri) &&
    new URL(ref).origin === origin &&
    origin.startsWith("https://")
  );
}

// One log line when a trusted app's request gets the page after all, so the
// maintainers can learn whether the apps send a Referer the page can be
// skipped on: a yes or no and the app's host, never the header itself.
export function logTrustedPage(h: Headers, redirectUri: string): void {
  console.info(
    JSON.stringify({
      event: "connector.trusted_page",
      app: new URL(redirectUri).host,
      referer_ok: refererMatches(h, redirectUri),
    }),
  );
}

// The request as the approval page saw it. method is the HTTP method the
// proxy recorded (src/proxy.ts), null if it didn't; repeated is whether any
// authorize parameter came more than once.
export type ApprovalRequest = {
  method: string | null;
  headers: Headers;
  repeated: boolean;
  authUserId: string | null;
  ipHash: string;
};

// Whether a request for a trusted app's callback skips the page: a GET with
// no parameter repeated and a state to send back, opened by a browser as a
// page, with a Referer on the app's site, while the site takes writes.
export function skipsPage(
  check: AuthorizeCheck,
  request: Pick<ApprovalRequest, "method" | "headers" | "repeated">,
): boolean {
  return (
    check.kind === "ok" &&
    isTrustedRedirect(check.redirectUri) &&
    !!check.input.state &&
    request.method === "GET" &&
    !request.repeated &&
    isPageNavigation(request.headers) &&
    refererMatches(request.headers, check.redirectUri) &&
    !isReadOnly()
  );
}

// What the approval page does with a request from a trusted app: go straight
// back with a code, or show the page after all (with the refusal, if one
// stopped it). Everything approve() checks is checked; only the button is
// skipped.
export type AutoApproval =
  | { kind: "approved"; url: string }
  | { kind: "page"; refusal?: ApiError };

export async function autoApprove(
  params: Record<string, string | undefined>,
  request: ApprovalRequest,
  issuer: string,
): Promise<AutoApproval> {
  const check = await checkAuthorize(params, issuer);
  if (!skipsPage(check, request)) return { kind: "page" };
  try {
    const url = await approve(
      params,
      request.authUserId,
      request.ipHash,
      issuer,
      { auto: true },
    );
    return { kind: "approved", url };
  } catch (err) {
    if (err instanceof ApiError) return { kind: "page", refusal: err };
    throw err;
  }
}

// The bucket a trusted app's grant counts its sign-up and connect-code tries
// against, and records as its bot's sign-up address, in place of the address
// of whoever approved it: anyone can send a person a link to such a grant, so
// what its token does must not spend that person's limits or be filed under
// their address. Shaped like an address's hash, derived from the grant alone.
export function grantBucket(grantId: number): string {
  return hashIp(`connector-grant:${grantId}`);
}

// The human said yes. A signed-in human becomes the bot's owner when it
// signs up; nobody needs to be signed in to say yes. authUserId comes from
// the session, never the form. auto: approved without the page (autoApprove).
// Any grant for a trusted app's callback, page or not, is marked
// auto_approved: its bot links to that person only through their own owner
// code, and its token's sign-up and tries count against grantBucket. So that
// a fresh bucket per grant doesn't lift the registration limit on whoever
// approves, the approval itself counts once against their address's
// registration limit, refused as a sign-up over it is.
export async function approve(
  params: Record<string, string | undefined>,
  authUserId: string | null,
  ipHash: string,
  issuer: string,
  opts: { auto?: boolean } = {},
): Promise<string> {
  assertWritable();
  const check = await checkAuthorize(params, issuer);
  if (check.kind === "show") throw new ApiError(400, "invalid", check.message);
  if (check.kind === "redirect") return check.url;
  const { client, input, redirectUri } = check;
  const trusted = isTrustedRedirect(redirectUri);
  const auto = opts.auto === true;
  if (auto && (!trusted || !input.state))
    throw new ApiError(400, "invalid", "This app needs the approval page.");
  return db().begin(async (tx) => {
    const limits = await antiAbuse(tx);
    await consume(tx, approveRules(ipHash, limits));
    if (trusted) await consume(tx, [registerAddressRule(ipHash, limits)]);
    const humanId =
      authUserId === null ? null : await ensureHuman(tx, authUserId);
    const code = randomBytes(32).toString("base64url");
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO connector_grants
        (client_id, owner_id, redirect_uri, code_challenge, code_hash, code_expires_at, ip_hash, auto_approved)
      VALUES (${client.id}, ${humanId}, ${redirectUri}, ${input.code_challenge},
              ${hashKey(code)}, now() + make_interval(mins => ${CODE_MINUTES}), ${ipHash}, ${trusted})
      RETURNING id`;
    if (!row) throw new Error("grant insert returned nothing");
    await logAction(tx, {
      action: "connector.approve",
      botId: null,
      keyId: null,
      humanId,
      subject: `grant:${row.id}`,
      ipHash,
      detail: {
        client: client.clientId,
        ...(trusted ? { trusted: true, auto } : {}),
      },
    });
    return backTo(redirectUri, { code, state: input.state, iss: issuer });
  });
}

export async function denyUrl(
  params: Record<string, string | undefined>,
  issuer: string,
): Promise<string> {
  const check = await checkAuthorize(params, issuer);
  if (check.kind === "show") throw new ApiError(400, "invalid", check.message);
  if (check.kind === "redirect") return check.url;
  return backTo(check.redirectUri, {
    error: "access_denied",
    state: check.input.state,
    iss: issuer,
  });
}

// A refused code exchange, with OAuth's error code (see oauthRoute).
export class OAuthError extends ApiError {
  constructor(error: "invalid_grant" | "invalid_request", message: string) {
    super(400, error, message);
  }
}

function challengeOf(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export async function exchangeCode(
  req: TokenRequest,
  ipHash: string,
): Promise<{ access_token: string; token_type: "Bearer" }> {
  const outcome = await db().begin(async (tx) => {
    const [g] = await tx<
      {
        id: string;
        client_id: string;
        redirect_uri: string;
        code_challenge: string;
        expired: boolean;
        exchanged: boolean;
        revoked: boolean;
      }[]
    >`
      SELECT g.id, c.client_id, g.redirect_uri, g.code_challenge,
             g.code_expires_at <= now() AS expired,
             g.exchanged_at IS NOT NULL AS exchanged,
             g.revoked_at IS NOT NULL AS revoked
      FROM connector_grants g JOIN oauth_clients c ON c.id = g.client_id
      WHERE g.code_hash = ${hashKey(req.code)}
      FOR UPDATE OF g`;
    if (!g || g.client_id !== req.client_id)
      return new OAuthError("invalid_grant", "That code isn't valid.");
    if (g.revoked)
      return new OAuthError("invalid_grant", "That code was revoked.");
    // PKCE means a code is worth nothing without its verifier, so a second
    // use, whether a client retrying or someone who saw the code, gets
    // nothing and takes nothing away.
    if (g.exchanged)
      return new OAuthError("invalid_grant", "That code was already used.");
    if (g.expired)
      return new OAuthError("invalid_grant", "That code has expired.");
    if (req.redirect_uri !== undefined && req.redirect_uri !== g.redirect_uri)
      return new OAuthError(
        "invalid_grant",
        "redirect_uri doesn't match the one the code was issued for.",
      );
    if (challengeOf(req.code_verifier) !== g.code_challenge)
      return new OAuthError(
        "invalid_grant",
        "code_verifier doesn't match the code_challenge.",
      );
    const token = newKey();
    await tx`
      UPDATE connector_grants SET exchanged_at = now(), token_hash = ${token.hash}
      WHERE id = ${g.id}`;
    await logAction(tx, {
      action: "connector.token",
      botId: null,
      keyId: null,
      subject: `grant:${g.id}`,
      ipHash,
    });
    return token.secret;
  });
  if (outcome instanceof OAuthError) throw outcome;
  return { access_token: outcome, token_type: "Bearer" };
}

// Who a connector token speaks for: a bot, once it has signed up, or a grant
// waiting for its sign-up. Anything else is no one.
export type TokenHolder =
  | { kind: "bot" }
  | { kind: "unbound"; grantId: number }
  | { kind: "none" };

export async function tokenHolder(
  token: string | undefined,
): Promise<TokenHolder> {
  if (!token) return { kind: "none" };
  if (await isKey(token)) return { kind: "bot" };
  const grant = await unboundGrant(db(), token);
  if (grant) return { kind: "unbound", grantId: grant.id };
  // A sign-up that committed between the two reads above made the key and
  // bound the grant at once, so the first read missed the key and the second
  // missed the grant. Look for the key again rather than turn its bot away.
  return (await isKey(token)) ? { kind: "bot" } : { kind: "none" };
}

async function isKey(token: string): Promise<boolean> {
  try {
    await callerForKey(token, { allowFrozen: true });
    return true;
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 401) throw err;
    return false;
  }
}

type UnboundGrant = {
  id: number;
  ownerId: number | null;
  ipHash: string | null;
  autoApproved: boolean;
};

async function unboundGrant(
  sql: postgres.Sql | postgres.TransactionSql,
  token: string,
): Promise<UnboundGrant | undefined> {
  const [row] = await sql<
    {
      id: string;
      owner_id: string | null;
      ip_hash: string | null;
      auto_approved: boolean;
    }[]
  >`
    SELECT id, owner_id, ip_hash, auto_approved FROM connector_grants
    WHERE token_hash = ${hashKey(token)} AND bot_id IS NULL AND revoked_at IS NULL
      AND exchanged_at > now() - make_interval(days => ${UNBOUND_TOKEN_DAYS})`;
  return row
    ? {
        id: Number(row.id),
        ownerId: row.owner_id === null ? null : Number(row.owner_id),
        ipHash: row.ip_hash,
        autoApproved: row.auto_approved,
      }
    : undefined;
}

// Signs the agent up with the token it already holds. The registration limit
// counts the address of the human who allowed it, not the client's server:
// a platform's servers connect for many people from a few addresses. A
// trusted app's grant counts against its own bucket instead (grantBucket);
// its approval already counted once against the approver's address.
export async function signUpWithToken(
  token: string,
  input: RegisterInput,
): Promise<{ bot: PublicBot; requestedHandle: string; unlinked: boolean }> {
  const grant = await unboundGrant(db(), token);
  if (!grant)
    throw new ApiError(
      409,
      "already_signed_up",
      "This connection has already signed up a bot, or it has expired. Use whoami to see who you are.",
    );
  const hash = hashKey(token);
  const address = grant.autoApproved
    ? grantBucket(grant.id)
    : (grant.ipHash ?? "unknown");
  const r = await registerBot(input, address, {
    key: { hash, prefix: token.slice(0, 12) },
    ownerId: grant.ownerId,
    linkWithoutCode: !grant.autoApproved,
    bind: async (tx, botId) => {
      const [bound] = await tx<{ id: string }[]>`
        UPDATE connector_grants SET bot_id = ${botId}
        WHERE id = ${grant.id} AND token_hash = ${hash}
          AND bot_id IS NULL AND revoked_at IS NULL
        RETURNING id`;
      if (!bound)
        throw new ApiError(
          409,
          "already_signed_up",
          "This connection has already signed up a bot. Use whoami to see who you are.",
        );
    },
  });
  // Whoever allowed it was signed in but already had as many bots as they
  // can link, so it joined on its own. (An owner code, when it brings one,
  // links it to the code's person instead, as over HTTP.) A connection
  // approved without the page never links without a code, so it says nothing.
  const unlinked =
    grant.ownerId !== null && !grant.autoApproved && !r.bot.claimed;
  return { bot: r.bot, requestedHandle: r.requestedHandle, unlinked };
}

// Becomes a bot its person owns, with the connect code they got for it (the
// connector's sign_up with handle and connect_code;
// src/lib/connect-codes.ts): the token this connection holds becomes that
// bot's key, as signing up would make it a new bot's, and every other key the
// bot had stops working. Only a connection that hasn't joined; tries count
// against the address of the human who allowed it, as sign-up does, and a
// connection with no such address is refused rather than share one bucket
// with every other. When the person who allowed the app was signed in, only
// a code they made works through it: a code someone else made gets the same
// refusal as any code that doesn't work, counted and logged alike.
export async function connectWithToken(
  token: string,
  input: { handle: string; code: string },
): Promise<{ bot: PublicBot }> {
  const grant = await unboundGrant(db(), token);
  if (!grant)
    throw new ApiError(
      409,
      "already_signed_up",
      "This connection is already a bot, or it has expired. A connect code is for a new connection: make one in your app, then call sign_up there with the handle and connect_code.",
    );
  // A trusted app's grant counts against its own bucket, never its
  // approver's address (grantBucket).
  const address = grant.autoApproved ? grantBucket(grant.id) : grant.ipHash;
  if (address === null)
    throw new ApiError(
      409,
      "connection_unusable",
      "This connection can't use a connect code: the site has no address to count its tries against. Make a new connection in your app, then call sign_up there with the handle and connect_code.",
    );
  const hash = hashKey(token);
  const r = await connectWithCode(input, address, {
    key: { hash, prefix: token.slice(0, 12) },
    via: "connector",
    ...(grant.ownerId === null ? {} : { madeBy: grant.ownerId }),
    bind: async (tx, botId) => {
      const [bound] = await tx<{ id: string }[]>`
        UPDATE connector_grants SET bot_id = ${botId}
        WHERE id = ${grant.id} AND token_hash = ${hash}
          AND bot_id IS NULL AND revoked_at IS NULL
        RETURNING id`;
      if (!bound)
        throw new ApiError(
          409,
          "already_signed_up",
          "This connection is already a bot. Use whoami to see which.",
        );
    },
  });
  return { bot: r.bot };
}
