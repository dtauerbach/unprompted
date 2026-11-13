import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as registerClientRoute } from "@/app/v1/oauth/register/route";
import { db } from "@/lib/db";
import { call, freshIp, resetDb } from "./helpers";

// Deny by default's one page that writes with no key: the approval page,
// which writes a grant on its own GET for a trusted app's callback, opened
// as a page from that app's own site (src/lib/connector.ts, skipsPage).
// Anything else that reaches it, a fetch, a frame, a prefetch, a HEAD or a
// POST, an untrusted callback, writes nothing.

const CHATGPT = "https://chatgpt.com/connector_platform_oauth_redirect";
const OTHER = "https://agent.example/callback";
const NAVIGATION = {
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "cross-site",
  "x-unprompted-method": "GET",
  referer: "https://chatgpt.com/",
};

const req = vi.hoisted(() => ({ headers: {} as Record<string, string> }));
const nav = vi.hoisted(() => ({ redirects: [] as string[] }));

vi.mock("@/lib/human-auth", () => ({
  humanSignInEnabled: () => true,
  cookieSecret: () => "s".repeat(64),
  sessionUser: async () => ({ id: "google-1", email: null }),
}));
vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers({
      "x-real-ip": "10.9.9.9",
      host: "unprompted.test",
      ...req.headers,
    }),
}));
vi.mock("@/lib/page-origin", () => ({
  pageOrigin: async () => "https://unprompted.test",
  pageRequestOrigin: async () => "https://unprompted.test",
}));
vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  connection: async () => {},
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    nav.redirects.push(to);
    throw new Error(`redirect ${to}`);
  },
}));

beforeEach(async () => {
  await resetDb();
  nav.redirects = [];
});

const appDir = path.join(process.cwd(), "src/app");
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

async function client(redirect: string): Promise<string> {
  const res = await call(registerClientRoute, {
    body: { redirect_uris: [redirect], client_name: "App" },
    ip: freshIp(),
  });
  return res.body.client_id;
}

async function open(redirect: string, headers: Record<string, string>) {
  req.headers = headers;
  const challenge = createHash("sha256")
    .update(randomBytes(32).toString("base64url"))
    .digest("base64url");
  const Page = (await import("@/app/oauth/authorize/page")).default;
  const fields = {
    response_type: "code",
    client_id: await client(redirect),
    redirect_uri: redirect,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "s",
  };
  try {
    renderToStaticMarkup(await Page({ searchParams: Promise.resolve(fields) }));
    return "page";
  } catch (err) {
    if (nav.redirects.length === 0) throw err;
    return "approved";
  }
}

async function written(): Promise<number> {
  const [r] = await db()<{ n: number }[]>`
    SELECT (SELECT count(*) FROM connector_grants)
         + (SELECT count(*) FROM humans) AS n`;
  return Number(r?.n ?? 0);
}

describe("deny by default, on pages", () => {
  it("has one page that approves, the approval page", () => {
    const found = sourceFiles(appDir)
      .filter((f) => /\bautoApprove\b/.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(appDir, f).split(path.sep).join("/"));
    expect(found).toEqual(["oauth/authorize/page.tsx"]);
  });

  it("writes nothing for a request that isn't a trusted app's page navigation by GET", async () => {
    for (const [redirect, headers] of [
      [OTHER, { ...NAVIGATION, referer: "https://agent.example/" }],
      [
        CHATGPT,
        { ...NAVIGATION, "sec-fetch-dest": "empty", "sec-fetch-mode": "cors" },
      ],
      [CHATGPT, { ...NAVIGATION, "sec-fetch-dest": "iframe" }],
      [CHATGPT, { ...NAVIGATION, "sec-purpose": "prefetch" }],
      [CHATGPT, { ...NAVIGATION, "x-unprompted-method": "HEAD" }],
      [CHATGPT, { ...NAVIGATION, "x-unprompted-method": "POST" }],
      [CHATGPT, { ...NAVIGATION, referer: "https://evil.example/" }],
    ] as [string, Record<string, string>][]) {
      expect(await open(redirect, headers), JSON.stringify(headers)).toBe(
        "page",
      );
      expect(await written()).toBe(0);
    }
  });

  it("writes a grant only for that one request", async () => {
    expect(await open(CHATGPT, NAVIGATION)).toBe("approved");
    expect(await written()).toBe(2);
  });
});
