import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { AUTHORIZE_PARAMS } from "./connector";
import { cookieSecret } from "./human-auth";

// Signing in from the approval page, and coming back to the same request.
// The request's fields ride in a short-lived cookie that only this site can
// write (HttpOnly, signed, scoped to the approval pages), under a nonce that
// is also the path Google sends the person back to. The return route only
// puts the fields back on the approval page's address: the page checks the
// request again from scratch and the person still presses Allow. So a link
// alone can't bring anyone back to a request: it has to be one this browser
// started here, within the cookie's life.

export const CONNECT_COOKIE = "unp_connect";
export const CONNECT_COOKIE_PATH = "/oauth/authorize";
export const CONNECT_RETURN_MINUTES = 15;
const NONCE_RE = /^[A-Za-z0-9_-]{22}$/;
// Under what a browser keeps of one cookie, with room for its name and flags.
const MAX_VALUE = 3800;

export type ReturnParams = Partial<
  Record<(typeof AUTHORIZE_PARAMS)[number], string>
>;

export function isNonce(value: unknown): value is string {
  return typeof value === "string" && NONCE_RE.test(value);
}

export function returnPath(nonce: string): string {
  return `${CONNECT_COOKIE_PATH}/return/${nonce}`;
}

function key(): string | undefined {
  const root = cookieSecret();
  return root
    ? createHmac("sha256", root)
        .update("unprompted:connect-return")
        .digest("hex")
    : undefined;
}

function mac(k: string, payload: string): string {
  return createHmac("sha256", k).update(payload).digest("base64url");
}

// Only the approval request's own fields, as strings.
function pick(params: Record<string, unknown>): ReturnParams {
  const out: ReturnParams = {};
  for (const k of AUTHORIZE_PARAMS) {
    const v = params[k];
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

// A new nonce and the cookie's value, or undefined when sign-in isn't set up
// or the request is too big to carry.
export function sealReturn(
  params: Record<string, unknown>,
  now = Date.now(),
): { nonce: string; value: string } | undefined {
  const k = key();
  if (!k) return undefined;
  const nonce = randomBytes(16).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      n: nonce,
      e: now + CONNECT_RETURN_MINUTES * 60_000,
      q: pick(params),
    }),
  ).toString("base64url");
  const value = `${payload}.${mac(k, payload)}`;
  return value.length <= MAX_VALUE ? { nonce, value } : undefined;
}

// The request a cookie carries, if it's one this site signed, for this
// nonce, and not yet expired.
export function openReturn(
  value: string | undefined,
  nonce: string,
  now = Date.now(),
): ReturnParams | undefined {
  const k = key();
  if (!k || !value || !isNonce(nonce) || value.length > MAX_VALUE)
    return undefined;
  const [payload, sig, extra] = value.split(".");
  if (!payload || !sig || extra !== undefined) return undefined;
  const want = Buffer.from(mac(k, payload));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got))
    return undefined;
  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof body !== "object" || body === null) return undefined;
  const { n, e, q } = body as { n?: unknown; e?: unknown; q?: unknown };
  if (n !== nonce || typeof e !== "number" || e < now) return undefined;
  if (typeof q !== "object" || q === null) return undefined;
  return pick(q as Record<string, unknown>);
}

// The approval page's address carrying the request again.
export function approvalPath(params: ReturnParams): string {
  const qs = new URLSearchParams(params as Record<string, string>).toString();
  return qs ? `${CONNECT_COOKIE_PATH}?${qs}` : CONNECT_COOKIE_PATH;
}
