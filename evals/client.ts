import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

// The harness talks to Unprompted only over HTTP, the way a stranger's bot
// would. Nothing here imports from src/.

export const BASE_URL = (
  process.env.EVAL_URL ?? "http://localhost:3000"
).replace(/\/$/, "");

const host = new URL(BASE_URL).hostname;

// Against a local server the harness may set X-Real-IP to play many bots from
// many addresses. A deployed site overwrites that header, so scenarios that
// need it (floods, more than a few registrations) run only locally.
export const LOCAL = host === "localhost" || host === "127.0.0.1";

if (!LOCAL && process.env.EVAL_REMOTE !== "1") {
  throw new Error(
    `EVAL_URL is ${BASE_URL}. Runs against a deployed site write real rows, so set EVAL_REMOTE=1 to confirm. Use a preview, not production.`,
  );
}

const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
const OUT_DIR = path.join(process.cwd(), "evals/out", RUN_ID);
const TRANSCRIPT = path.join(OUT_DIR, "http.jsonl");
mkdirSync(OUT_DIR, { recursive: true });

// Short and unique per run, so remote runs never collide on handles.
export const RUN_TAG = Math.random().toString(36).slice(2, 6);

export type Res = {
  status: number;
  headers: Headers;
  // biome-ignore lint/suspicious/noExplicitAny: scenarios read arbitrary JSON
  json: any;
  text: string;
};

// A different block of addresses each run, so a rerun within the hour doesn't
// inherit the last run's per-address counts.
const ipBlock = 1 + Math.floor(Math.random() * 250);
let ipCounter = 0;
export function freshIp(): string {
  ipCounter += 1;
  return `10.${ipBlock}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

// Keys never reach the transcript, even throwaway local ones.
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) =>
        k === "api_key" ? [k, "[redacted]"] : [k, redact(v)],
      ),
    );
  }
  return value;
}

export async function request(
  method: string,
  pathname: string,
  opts: { key?: string; body?: unknown; rawBody?: string; ip?: string } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (opts.key) headers.authorization = `Bearer ${opts.key}`;
  if (LOCAL && opts.ip) headers["x-real-ip"] = opts.ip;
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypass) headers["x-vercel-protection-bypass"] = bypass;
  let body: string | undefined = opts.rawBody;
  if (body === undefined && opts.body !== undefined)
    body = JSON.stringify(opts.body);
  if (body !== undefined) headers["content-type"] = "application/json";

  const started = Date.now();
  const res = await fetch(`${BASE_URL}${pathname}`, {
    method,
    headers,
    body,
    redirect: "manual",
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {}
  appendFileSync(
    TRANSCRIPT,
    `${JSON.stringify({
      at: new Date(started).toISOString(),
      ms: Date.now() - started,
      method,
      path: pathname,
      ip: LOCAL ? opts.ip : undefined,
      keyed: Boolean(opts.key),
      request: opts.body === undefined ? opts.rawBody : opts.body,
      status: res.status,
      response: json === undefined ? text.slice(0, 2000) : redact(json),
    })}\n`,
  );
  return { status: res.status, headers: res.headers, json, text };
}

export const get = (p: string, key?: string) => request("GET", p, { key });

export const post = (
  p: string,
  body: unknown,
  opts: { key?: string; ip?: string } = {},
) => request("POST", p, { ...opts, body });

export type Bot = { handle: string; key: string; ip: string };

// Registers a bot from its own address. Remote handles carry the run tag so
// they're easy to recognise and never clash with real bots.
export async function register(
  name: string,
  extra: Record<string, unknown> = {},
): Promise<Bot> {
  const ip = freshIp();
  const handle = LOCAL ? name : `eval-${RUN_TAG}-${name}`.slice(0, 30);
  const res = await post("/v1/bots", { handle, ...extra }, { ip });
  if (res.status !== 201)
    throw new Error(`register ${handle}: ${res.status} ${res.text}`);
  return { handle: res.json.bot.handle, key: res.json.api_key, ip };
}

// Remote posts say what they are, so a human reading a preview can tell.
export function label(text: string): string {
  return LOCAL ? text : `[eval ${RUN_TAG}] ${text}`;
}
