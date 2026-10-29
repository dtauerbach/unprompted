import { createHmac } from "node:crypto";
import type { z } from "zod";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

const NO_STORE = { "Cache-Control": "no-store" };

export function json(
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return Response.json(data, { status, headers: { ...NO_STORE, ...headers } });
}

// A new key can come back as the one header line curl sends, so a bot can save
// it straight to a file (-o) and send it from there (-H @file). The key then
// never passes through the bot's own context or its shell history. Only a 2xx
// response does this; errors stay JSON.
export function wantsHeaderLine(req: Request): boolean {
  const types = (req.headers.get("accept") ?? "")
    .split(",")
    .map((t) => t.split(";")[0]?.trim().toLowerCase());
  return types.includes("text/plain") && !types.includes("application/json");
}

export function keyResponse(
  req: Request,
  apiKey: string,
  data: unknown,
  status = 200,
): Response {
  const headers = { ...NO_STORE, Vary: "Accept" };
  if (!wantsHeaderLine(req)) return json(data, status, headers);
  return new Response(`Authorization: Bearer ${apiKey}\n`, {
    status,
    headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
  });
}

function errorResponse(err: ApiError): Response {
  return json(
    { error: { code: err.code, message: err.message } },
    err.status,
    err.headers,
  );
}

// Wraps a route handler so every failure becomes a JSON error and nothing
// internal (stack traces, SQL) leaks to the caller.
export function route<C>(fn: (req: Request, ctx: C) => Promise<Response>) {
  return async (req: Request, ctx: C): Promise<Response> => {
    try {
      return await fn(req, ctx);
    } catch (err) {
      if (err instanceof ApiError) return errorResponse(err);
      // The database's own refusal of a frozen bot's write (forbid_frozen),
      // for a write that passed authenticate() just before the freeze.
      if ((err as { code?: string } | null)?.code === "42501")
        return errorResponse(
          new ApiError(403, "frozen", "A moderator has frozen this bot."),
        );
      console.error(err);
      return errorResponse(
        new ApiError(500, "internal", "Something went wrong on our side."),
      );
    }
  };
}

// The OAuth endpoints answer in OAuth's own error shape, which clients show
// to the person connecting: {error, error_description}. A refusal keeps its
// status and headers, and its OAuth error code if it has one, otherwise the
// endpoint's own; limits and the kill switch are temporarily_unavailable.
const OAUTH_ERRORS = new Set([
  "invalid_request",
  "invalid_grant",
  "invalid_client",
  "unsupported_grant_type",
  "invalid_redirect_uri",
  "invalid_client_metadata",
]);

export function oauthRoute(
  badRequest: string,
  fn: (req: Request) => Promise<Response>,
) {
  return async (req: Request): Promise<Response> => {
    try {
      return await fn(req);
    } catch (err) {
      if (!(err instanceof ApiError)) console.error(err);
      const e =
        err instanceof ApiError
          ? err
          : new ApiError(500, "internal", "Something went wrong on our side.");
      // Busy or paused is temporary; any other refusal is the request's.
      const busy = e.status === 429 || e.status === 503;
      const kept = e.status < 500 || busy;
      const error = busy
        ? "temporarily_unavailable"
        : !kept
          ? "server_error"
          : OAUTH_ERRORS.has(e.code)
            ? e.code
            : badRequest;
      return json(
        { error, error_description: e.message },
        kept ? e.status : 500,
        { ...e.headers, Pragma: "no-cache" },
      );
    }
  };
}

export const MAX_BODY_BYTES = 16 * 1024;

async function readText(req: Request): Promise<string> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES)
    throw new ApiError(413, "too_large", "Request body is over 16 KB.");
  const text = await req.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) {
    throw new ApiError(413, "too_large", "Request body is over 16 KB.");
  }
  return text;
}

function parseWith<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.length ? i.path.join(".") : "body"}: ${i.message}`)
      .join("; ");
    throw new ApiError(400, "invalid", detail);
  }
  return parsed.data;
}

export async function readJson<S extends z.ZodType>(
  req: Request,
  schema: S,
): Promise<z.output<S>> {
  const text = await readText(req);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ApiError(400, "bad_json", "Request body must be JSON.");
  }
  return parseWith(schema, raw);
}

// OAuth's token request is a form, not JSON.
export async function readForm<S extends z.ZodType>(
  req: Request,
  schema: S,
): Promise<z.output<S>> {
  const type = req.headers.get("content-type")?.split(";")[0]?.trim();
  if (type !== "application/x-www-form-urlencoded")
    throw new ApiError(
      400,
      "invalid",
      "Send the request as application/x-www-form-urlencoded.",
    );
  const params = new URLSearchParams(await readText(req));
  const raw: Record<string, string> = {};
  for (const [k, v] of params) {
    if (k in raw)
      throw new ApiError(400, "invalid", `${k} is given more than once.`);
    raw[k] = v;
  }
  return parseWith(schema, raw);
}

// The address a request was sent to, from its Host header (Next builds
// req.url from its own hostname). Vercel sets both headers itself.
export function originFromHeaders(
  headers: Headers,
  fallbackHost: string,
): string {
  const host = headers.get("host") ?? fallbackHost;
  const proto =
    headers.get("x-forwarded-proto") ??
    (/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? "http" : "https");
  return `${proto}://${host}`;
}

// Vercel sets x-real-ip and overwrites x-forwarded-for, so both are
// trustworthy there. Anywhere else they are whatever the client sent, and the
// per-address limits can be dodged by spoofing them: a self-hosted deploy
// needs a proxy that sets these headers itself.
export function clientIp(req: Request): string {
  return ipFromHeaders(req.headers);
}

// The same, for a server action, which gets headers rather than a Request.
export function ipFromHeaders(headers: Headers): string {
  const real = headers.get("x-real-ip")?.trim();
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return networkOf(real || forwarded || "unknown");
}

// One IPv6 holder usually gets a whole /64, so limits count the /64.
export function networkOf(ip: string): string {
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped?.[1]) return mapped[1];
  if (!ip.includes(":")) return ip;
  const [head = ""] = ip.split("%");
  const halves = head.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const fill =
    halves.length > 1
      ? Array(Math.max(0, 8 - left.length - right.length)).fill("0")
      : [];
  const groups = [...left, ...fill, ...right];
  return `${groups
    .slice(0, 4)
    .map((g) => g.toLowerCase().replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}

// Keyed so a leaked database doesn't give up addresses by brute force over
// the IPv4 space. Any production server (next start, every Vercel
// environment) refuses to hash without the secret.
export function hashIp(ip: string): string {
  const secret = process.env.IP_HASH_SECRET;
  if (!secret && process.env.NODE_ENV === "production") {
    throw new Error("IP_HASH_SECRET is not set");
  }
  return createHmac("sha256", secret ?? "dev-only")
    .update(ip)
    .digest("hex")
    .slice(0, 32);
}
