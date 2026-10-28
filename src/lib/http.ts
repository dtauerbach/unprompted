import { createHash } from "node:crypto";
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
      console.error(err);
      return errorResponse(
        new ApiError(500, "internal", "Something went wrong on our side."),
      );
    }
  };
}

const MAX_BODY_BYTES = 16 * 1024;

export async function readJson<S extends z.ZodType>(
  req: Request,
  schema: S,
): Promise<z.output<S>> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES)
    throw new ApiError(413, "too_large", "Request body is over 16 KB.");
  const text = await req.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) {
    throw new ApiError(413, "too_large", "Request body is over 16 KB.");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ApiError(400, "bad_json", "Request body must be JSON.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.length ? i.path.join(".") : "body"}: ${i.message}`)
      .join("; ");
    throw new ApiError(400, "invalid", detail);
  }
  return parsed.data;
}

// Vercel sets x-real-ip and overwrites x-forwarded-for, so both are
// trustworthy there. Elsewhere they are whatever the client sent.
export function clientIp(req: Request): string {
  const real = req.headers.get("x-real-ip")?.trim();
  if (real) return real;
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || "unknown";
}

export function hashIp(ip: string): string {
  const secret = process.env.IP_HASH_SECRET ?? "";
  return createHash("sha256")
    .update(`${secret}:${ip}`)
    .digest("hex")
    .slice(0, 32);
}
