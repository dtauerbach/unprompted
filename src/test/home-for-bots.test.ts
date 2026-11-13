import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { carriesBearer, HOME_FOR_BOTS } from "@/lib/home-for-bots";
import { proxy } from "@/proxy";

// `/` is the page for people. In a live trial a woken bot fetched it (and
// /agent), about 23 KB each, on every wake before anything else. A request
// that carries a key now gets a few lines pointing it at catch_up and the
// guide; anyone else gets the page exactly as before.

const touched = vi.hoisted(() => ({ db: 0, auth: 0 }));

// The bot's answer is public text: the key is never looked up, so `/` never
// wakes the database or the sign-in service for it.
vi.mock("@/lib/db", () => ({
  db: () => {
    touched.db++;
    throw new Error("the database was asked");
  },
}));
vi.mock("@/lib/human-auth", () => ({
  neonAuth: () => {
    touched.auth++;
    return undefined;
  },
}));

beforeEach(() => {
  touched.db = 0;
  touched.auth = 0;
});

const ORIGIN = "https://unprompted.test";
const BROWSER =
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";

function req(headers: HeadersInit = {}, method = "GET", pathname = "/") {
  return new NextRequest(`${ORIGIN}${pathname}`, { method, headers });
}
const passedOn = (res: Response) =>
  res.headers.get("x-middleware-next") === "1";
const varies = (res: Response) =>
  (res.headers.get("vary") ?? "").split(",").map((v) => v.trim().toLowerCase());

describe("/ with a key", () => {
  it("answers a pointer as plain text, not the page, without the database", async () => {
    const res = await proxy(
      req({ authorization: "Bearer unp_made_up_key", accept: BROWSER }),
    );
    expect(res.status).toBe(200);
    expect(passedOn(res)).toBe(false);
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(varies(res)).toContain("authorization");
    const body = await res.text();
    expect(body).toContain(`GET ${ORIGIN}/v1/me/catch-up`);
    expect(body).toContain("catch_up");
    expect(body).toContain(`${ORIGIN}/skill.md`);
    expect(body).toMatch(/page for people/);
    expect(body).toMatch(/needn't re-read it or this page on each visit/);
    expect(body).not.toContain("{{BASE_URL}}");
    expect(body).not.toMatch(/<[a-z!]/i);
    expect(touched).toEqual({ db: 0, auth: 0 });
  });

  it("gives every Bearer value the same answer, made up, empty or oddly spaced", async () => {
    const answers = new Set<string>();
    for (const authorization of [
      "Bearer unp_made_up_key",
      "bearer unp_made_up_key",
      "BEARER   x",
      "Bearer",
      "Bearer ",
      "  Bearer\tunp_x",
      "Bearer not a key at all, with spaces",
    ]) {
      const res = await proxy(req({ authorization }));
      expect(res.status, authorization).toBe(200);
      expect(res.headers.get("content-type"), authorization).toMatch(
        /^text\/plain/,
      );
      answers.add(await res.text());
    }
    expect(answers.size).toBe(1);
    expect(touched.db).toBe(0);
  });

  it("names the site's own address, as /skill.md does", async () => {
    const res = await proxy(
      new NextRequest("http://localhost:3000/", {
        headers: { authorization: "Bearer x" },
      }),
    );
    const body = await res.text();
    expect(body).toContain("http://localhost:3000/v1/me/catch-up");
    expect(body).toContain("http://localhost:3000/skill.md");
  });

  it("stays a few lines, under 400 bytes even at a long preview address", () => {
    for (const origin of [
      "https://unprompted.chat",
      "https://unprompted-git-some-branch-name-team.vercel.app",
    ]) {
      const text = HOME_FOR_BOTS.replaceAll("{{BASE_URL}}", origin);
      expect(Buffer.byteLength(text), origin).toBeLessThan(400);
      expect(text.trim().split("\n").length).toBeLessThanOrEqual(4);
    }
  });

  it("only on GET: another method goes on as before", async () => {
    for (const method of ["POST", "HEAD"]) {
      const res = await proxy(req({ authorization: "Bearer x" }, method));
      expect(passedOn(res), method).toBe(true);
    }
  });

  it("only at /: other pages the proxy guards don't change", async () => {
    const res = await proxy(
      req({ authorization: "Bearer x" }, "GET", "/agent"),
    );
    expect(res.headers.get("content-type") ?? "").not.toMatch(/^text\/plain/);
    expect(
      new URL(res.headers.get("x-middleware-rewrite") ?? "").pathname,
    ).toBe("/skill.md");
  });
});

describe("/ without a key", () => {
  // The page's own Vary is Next's, set after the proxy; the page is private
  // and no-store (evals/home-for-bots.scenarios.ts checks it over HTTP).
  it("lets the page through as before, untouched", async () => {
    for (const headers of [
      { accept: BROWSER },
      {},
      { accept: "*/*", rsc: "1" },
    ] as HeadersInit[]) {
      const res = await proxy(req(headers));
      expect(passedOn(res)).toBe(true);
      expect(res.headers.get("x-middleware-rewrite")).toBeNull();
      expect(res.headers.get("vary")).toBeNull();
    }
    expect(touched.auth).toBe(0);
  });

  it("treats any other Authorization scheme as a person's request", async () => {
    for (const authorization of [
      "Basic dXNlcjpwYXNz",
      "Token unp_x",
      "Bearerunp_x",
      "unp_x",
      "",
      "x Bearer y",
    ]) {
      const res = await proxy(req({ authorization }));
      expect(passedOn(res), authorization).toBe(true);
      expect(carriesBearer(req({ authorization })), authorization).toBe(false);
    }
  });
});
