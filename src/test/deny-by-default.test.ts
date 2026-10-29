import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { call } from "./helpers";

// Every write endpoint must refuse a request with no key. The exceptions are
// where keys come from: registering a bot, and the connector's OAuth client
// registration and code exchange (src/test/connector.test.ts). A new route
// that forgets to authenticate fails this test without anyone having to
// remember to add it.
const OPEN_WRITES = new Set([
  "POST /v1/bots",
  "POST /v1/oauth/register",
  "POST /v1/oauth/token",
]);
const WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return routeFiles(full);
    return name === "route.ts" ? [full] : [];
  });
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

const appDir = path.join(process.cwd(), "src/app");
const files = routeFiles(appDir);

describe("deny by default", () => {
  it("finds the route files", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  // A vote is taken back with DELETE, the one write here that isn't a POST,
  // so the loop below has to reach it.
  it("finds both of the vote route's writes", async () => {
    const vote = files.find((f) =>
      f.endsWith(path.join("posts", "[id]", "vote", "route.ts")),
    );
    expect(vote).toBeDefined();
    const mod = (await import(vote ?? "")) as Record<string, unknown>;
    expect(typeof mod.POST).toBe("function");
    expect(typeof mod.DELETE).toBe("function");
    expect(OPEN_WRITES.has("POST /v1/posts/[id]/vote")).toBe(false);
    expect(OPEN_WRITES.has("DELETE /v1/posts/[id]/vote")).toBe(false);
  });

  for (const file of files) {
    const urlPath = `/${path.relative(appDir, path.dirname(file)).split(path.sep).join("/")}`;
    it(`${urlPath}: every write needs a key`, async () => {
      const mod = (await import(file)) as Record<string, unknown>;
      for (const method of WRITE_METHODS) {
        const handler = mod[method];
        if (typeof handler !== "function") continue;
        if (OPEN_WRITES.has(`${method} ${urlPath}`)) continue;
        const res = await call(
          handler as (req: Request, ctx: unknown) => Promise<Response>,
          {
            method,
            path: urlPath.replace(/\[(\w+)\]/g, "1"),
            body: { channel: "meta", body: "x", reply_to: 1 },
            params: { id: "1", slug: "meta", handle: "alice" },
          },
        );
        // The code, not just the status, so a 401 for some other reason can't pass.
        expect(res.status, `${method} ${urlPath}`).toBe(401);
        expect(res.body?.error?.code, `${method} ${urlPath}`).toBe(
          "missing_key",
        );
      }
    });
  }

  // Server actions are writes too. Each file of them is listed here, and
  // its test calls every action in it with no session: humans.test.ts,
  // connector.test.ts or admin-web.test.ts.
  it("has server actions only where they're tested", () => {
    const SERVER_ACTION_FILES = [
      "account/actions.ts",
      "admin/actions.ts",
      "oauth/authorize/actions.ts",
    ];
    const found = sourceFiles(appDir)
      .filter((f) => /^\s*["']use server["']/m.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(appDir, f).split(path.sep).join("/"));
    expect(found).toEqual(SERVER_ACTION_FILES);
  });

  it("has no write routes outside /v1", () => {
    for (const file of files) {
      const rel = path.relative(appDir, file);
      if (rel.startsWith(`v1${path.sep}`)) continue;
      const src = readFileSync(file, "utf8");
      for (const m of WRITE_METHODS)
        expect(src, rel).not.toMatch(
          new RegExp(`export\\s+(const|async function|function)\\s+${m}\\b`),
        );
    }
  });
});
