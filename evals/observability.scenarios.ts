import { describe, expect, it } from "vitest";
import { get, post, register, request } from "./client";
import { admin, MODERATOR, mustAdmin } from "./moderator";

// What the people running the site look at: the uptime check anyone may call,
// and the moderator's stats, read with the admin script. board.eval.ts calls
// this before the floods.

// Sums the joined and posts columns of the stats table's hour rows.
function totals(out: string): { joined: number; posts: number } {
  let joined = 0;
  let posts = 0;
  for (const m of out.matchAll(
    /^\d{4}-\d\d-\d\dT\d\d:00\s+(\d+) \(\s*\d+\)\s+(\d+)/gm,
  )) {
    joined += Number(m[1]);
    posts += Number(m[2]);
  }
  return { joined, posts };
}

export function observabilityScenarios(): void {
  describe("the health check", () => {
    it("says the site is up and nothing more, and takes no writes", async () => {
      const res = await get("/v1/health");
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.json).toEqual({ ok: true, read_only: false });
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const r = await request(method, "/v1/health", { body: {} });
        expect(r.status, method).toBe(405);
      }
      expect((await get("/v1")).json.endpoints).toContain("GET /v1/health");
    });
  });

  describe.runIf(MODERATOR)("a moderator's stats", () => {
    it("count each join and post, and name no address", async () => {
      const before = totals(mustAdmin("stats", "--hours", "720"));
      const lark = await register("lark");
      const res = await post(
        "/v1/posts",
        { channel: "small-talk", body: "Counting myself in." },
        { key: lark.key, ip: lark.ip },
      );
      expect(res.status).toBe(201);
      const out = mustAdmin("stats", "--hours", "720");
      expect(out).toMatch(/^Last 720h\. Registration open\./);
      expect(totals(out)).toEqual({
        joined: before.joined + 1,
        posts: before.posts + 1,
      });
      expect(out).toMatch(/^address [0-9a-f]{8}…: \d+ registration\(s\)$/m);
      expect(out).toMatch(/^@[a-z0-9_-]+: \d+ post\(s\)$/m);
      expect(out).not.toContain(lark.ip);
      expect(out).not.toContain(lark.key);
    });

    it("refuse a window they can't read", () => {
      for (const hours of ["0", "1.5", "721", "lots"]) {
        const run = admin("stats", "--hours", hours);
        expect(run.ok, hours).toBe(false);
        expect(run.out).toMatch(/whole number from 1 to 720/);
      }
    });
  });
}
