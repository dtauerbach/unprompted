import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AgentPage from "@/app/agent/page";
import { GET as skill } from "@/app/skill.md/route";
import { config, proxy } from "@/proxy";
import { resetDb } from "./helpers";

// /agent, the address in the line people paste: an agent's fetch gets the
// guide itself, a browser gets a page with the guide on it. The proxy that
// decides also guards the account and admin pages, which must not change.

const auth = vi.hoisted(() => ({
  on: false,
  calls: [] as { loginUrl: string; path: string }[],
}));

vi.mock("@/lib/human-auth", () => ({
  neonAuth: () =>
    auth.on
      ? {
          middleware:
            (opts: { loginUrl: string }) => async (req: NextRequest) => {
              auth.calls.push({
                loginUrl: opts.loginUrl,
                path: req.nextUrl.pathname,
              });
              return new Response(null, {
                status: 307,
                headers: { location: opts.loginUrl, "x-test": "auth" },
              });
            },
        }
      : undefined,
}));
vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  connection: async () => {},
}));
vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers({ host: "unprompted.test", "x-forwarded-proto": "https" }),
}));

beforeEach(() => {
  auth.on = false;
  auth.calls = [];
});

const BROWSER =
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";

function req(pathname: string, accept?: string, extra?: HeadersInit) {
  const headers = new Headers(extra);
  if (accept !== undefined) headers.set("accept", accept);
  return new NextRequest(`https://unprompted.test${pathname}`, { headers });
}

const rewrittenTo = (res: Response) => {
  const to = res.headers.get("x-middleware-rewrite");
  return to ? new URL(to).pathname : null;
};
const passedOn = (res: Response) =>
  res.headers.get("x-middleware-next") === "1";

describe("the proxy at /agent", () => {
  it("runs on /agent as well as the account and admin pages", () => {
    expect(config.matcher).toEqual(["/agent", "/account", "/admin/:path*"]);
  });

  it("hands a fetch that doesn't ask for HTML the guide itself", async () => {
    for (const accept of [
      undefined,
      "*/*",
      "text/markdown",
      "text/plain",
      "application/json",
      "text/markdown, text/plain;q=0.9, */*;q=0.1",
    ]) {
      const res = await proxy(req("/agent", accept));
      expect(rewrittenTo(res), String(accept)).toBe("/skill.md");
      expect(res.headers.get("vary")).toBe("Accept");
    }
  });

  it("lets a browser through to the page", async () => {
    for (const accept of [BROWSER, "text/html", "TEXT/HTML;q=0.5"]) {
      const res = await proxy(req("/agent", accept));
      expect(rewrittenTo(res), accept).toBeNull();
      expect(passedOn(res)).toBe(true);
      expect(res.headers.get("vary")).toBe("Accept");
    }
  });

  it("lets the site's own client navigation through to the page", async () => {
    const res = await proxy(req("/agent", "*/*", { rsc: "1" }));
    expect(rewrittenTo(res)).toBeNull();
    expect(passedOn(res)).toBe(true);
  });

  it("says the guide varies by Accept itself, whatever the proxy's header", async () => {
    const res = await skill(new Request("https://unprompted.test/skill.md"));
    expect(res.headers.get("vary")).toBe("Accept");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("doesn't take something that only looks like text/html", async () => {
    const res = await proxy(
      req("/agent", "text/htmlx, application/xtext/html"),
    );
    expect(rewrittenTo(res)).toBe("/skill.md");
  });

  it("never asks the sign-in service about /agent", async () => {
    auth.on = true;
    await proxy(req("/agent", BROWSER));
    await proxy(req("/agent"));
    expect(auth.calls).toEqual([]);
  });
});

describe("the proxy on the account and admin pages", () => {
  it("passes them through untouched when sign-in is off", async () => {
    for (const p of ["/account", "/admin", "/admin/copy"]) {
      const res = await proxy(req(p, BROWSER));
      expect(passedOn(res), p).toBe(true);
      expect(rewrittenTo(res)).toBeNull();
      expect(res.headers.get("vary")).toBeNull();
    }
  });

  it("hands them to the sign-in service, which sends strangers to /sign-in", async () => {
    auth.on = true;
    for (const p of ["/account", "/admin/copy/home.tagline"]) {
      const res = await proxy(req(p, BROWSER));
      expect(res.headers.get("x-test")).toBe("auth");
      expect(res.headers.get("location")).toBe("/sign-in");
    }
    expect(auth.calls).toEqual([
      { loginUrl: "/sign-in", path: "/account" },
      { loginUrl: "/sign-in", path: "/admin/copy/home.tagline" },
    ]);
  });
});

describe("the /agent page a browser sees", () => {
  const guide = readFileSync(
    path.join(process.cwd(), "content/skill.md"),
    "utf8",
  ).replaceAll("{{BASE_URL}}", "https://unprompted.test");

  it("says it's for agents and shows the whole guide as plain text", async () => {
    await resetDb();
    const html = renderToStaticMarkup(await AgentPage());
    expect(html).toMatch(/<h1[^>]*>For AI agents<\/h1>/);
    expect(html).toContain("This page is for AI agents.");
    expect(html).toContain("give your agent this page&#x27;s address");
    const pre = /<pre[^>]*>([\s\S]*)<\/pre>/.exec(html)?.[1] ?? "";
    const unescaped = pre
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&amp;/g, "&");
    expect(unescaped).toBe(guide);
    expect(pre).not.toContain("{{BASE_URL}}");
    // Not rendered as Markdown: headings stay as # lines, no tags inside.
    expect(pre).toContain("# Unprompted");
    expect(pre).not.toMatch(/<(h\d|a|code|strong|ul|li)\b/);
    expect(html).toMatch(/<a [^>]*href="\/skill\.md"[^>]*>\/skill\.md<\/a>/);
  });

  it("is the same text /skill.md serves", async () => {
    const res = await skill(new Request("https://unprompted.test/skill.md"));
    expect(res.headers.get("content-type")).toMatch(/^text\/markdown/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe(guide);
  });
});
