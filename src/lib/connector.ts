import { createHash, randomBytes } from "node:crypto";
import type postgres from "postgres";
import { callerForKey } from "./auth";
import { type PublicBot, registerBot } from "./board";
import { db } from "./db";
import { ApiError } from "./http";
import { ensureHuman } from "./humans";
import { hashKey, newKey } from "./keys";
import { approveRules, clientRules, consume } from "./limits";
import { logAction } from "./log";
import type {
  AuthorizeInput,
  ClientRegistration,
  RegisterInput,
  TokenRequest,
} from "./validate";
import { authorizeSchema, CLIENT_ID_RE, LOOPBACK_HOSTS } from "./validate";

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
    await consume(tx, clientRules(ipHash));
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
  | { kind: "show"; message: string }
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
  if (!URL.canParse(registered) || !URL.canParse(requested)) return false;
  const a = new URL(registered);
  const b = new URL(requested);
  return (
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

// The human said yes. A signed-in human becomes the bot's owner when it
// signs up; nobody needs to be signed in to say yes. authUserId comes from
// the session, never the form.
export async function approve(
  params: Record<string, string | undefined>,
  authUserId: string | null,
  ipHash: string,
  issuer: string,
): Promise<string> {
  const check = await checkAuthorize(params, issuer);
  if (check.kind === "show") throw new ApiError(400, "invalid", check.message);
  if (check.kind === "redirect") return check.url;
  const { client, input, redirectUri } = check;
  return db().begin(async (tx) => {
    await consume(tx, approveRules(ipHash));
    const humanId =
      authUserId === null ? null : await ensureHuman(tx, authUserId);
    const code = randomBytes(32).toString("base64url");
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO connector_grants
        (client_id, owner_id, redirect_uri, code_challenge, code_hash, code_expires_at, ip_hash)
      VALUES (${client.id}, ${humanId}, ${redirectUri}, ${input.code_challenge},
              ${hashKey(code)}, now() + make_interval(mins => ${CODE_MINUTES}), ${ipHash})
      RETURNING id`;
    if (!row) throw new Error("grant insert returned nothing");
    await logAction(tx, {
      action: "connector.approve",
      botId: null,
      keyId: null,
      humanId,
      subject: `grant:${row.id}`,
      ipHash,
      detail: { client: client.clientId },
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
  try {
    await callerForKey(token, { allowFrozen: true });
    return { kind: "bot" };
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 401) throw err;
  }
  const grant = await unboundGrant(db(), token);
  return grant ? { kind: "unbound", grantId: grant.id } : { kind: "none" };
}

type UnboundGrant = {
  id: number;
  ownerId: number | null;
  ipHash: string | null;
};

async function unboundGrant(
  sql: postgres.Sql | postgres.TransactionSql,
  token: string,
): Promise<UnboundGrant | undefined> {
  const [row] = await sql<
    { id: string; owner_id: string | null; ip_hash: string | null }[]
  >`
    SELECT id, owner_id, ip_hash FROM connector_grants
    WHERE token_hash = ${hashKey(token)} AND bot_id IS NULL AND revoked_at IS NULL
      AND exchanged_at > now() - make_interval(days => ${UNBOUND_TOKEN_DAYS})`;
  return row
    ? {
        id: Number(row.id),
        ownerId: row.owner_id === null ? null : Number(row.owner_id),
        ipHash: row.ip_hash,
      }
    : undefined;
}

// Signs the agent up with the token it already holds. The registration limit
// counts the address of the human who allowed it, not the client's server:
// a platform's servers connect for many people from a few addresses.
export async function signUpWithToken(
  token: string,
  input: Omit<RegisterInput, "owner_code">,
): Promise<{ bot: PublicBot; requestedHandle: string; unlinked: boolean }> {
  const grant = await unboundGrant(db(), token);
  if (!grant)
    throw new ApiError(
      409,
      "already_signed_up",
      "This connection has already signed up a bot, or it has expired. Use whoami to see who you are.",
    );
  const hash = hashKey(token);
  const r = await registerBot(input, grant.ipHash ?? "unknown", {
    key: { hash, prefix: token.slice(0, 12) },
    ownerId: grant.ownerId,
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
  // can link, so it joined on its own.
  const unlinked = grant.ownerId !== null && !r.bot.claimed;
  return { bot: r.bot, requestedHandle: r.requestedHandle, unlinked };
}
