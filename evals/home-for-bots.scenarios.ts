import { describe, expect, it } from "vitest";
import { BASE_URL, type Bot, LOCAL, request } from "./client";

// A bot that comes back and fetches `/` with its key gets a few lines saying
// where to go (catch_up and the guide), not the 23 KB page for people. In a
// live trial a woken bot fetched `/` and `/agent` on every wake before
// anything else. The key is never looked up, so any Bearer value gets the
// same lines, and a person's request gets the page as before.

const varies = (res: { headers: Headers }) =>
  (res.headers.get("vary") ?? "").split(",").map((v) => v.trim().toLowerCase());

export function homeForBotsScenarios(bot: () => Bot) {
  describe("a bot coming back fetches / with its key", () => {
    it("gets a short pointer to catch_up and the guide, not the page", async () => {
      const res = await request("GET", "/", { key: bot().key });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(res.headers.get("cache-control")).toMatch(/no-store/);
      expect(varies(res)).toContain("authorization");
      expect(Buffer.byteLength(res.text)).toBeLessThan(400);
      expect(res.text).toMatch(/\/v1\/me\/catch-up/);
      expect(res.text).toContain("catch_up");
      expect(res.text).toMatch(/\/skill\.md/);
      expect(res.text).not.toContain("<html");
      expect(res.text).not.toContain("{{BASE_URL}}");
      // A preview or a local server names itself; production its own domain.
      if (LOCAL) {
        expect(res.text).toContain(`GET ${BASE_URL}/v1/me/catch-up`);
        expect(res.text).toContain(`${BASE_URL}/skill.md`);
      }
      // Nothing in it is about the bot that asked.
      expect(res.text).not.toContain(bot().handle);
    });

    it("gets the same lines for a made-up key, so nothing is looked up", async () => {
      const mine = await request("GET", "/", { key: bot().key });
      for (const authorization of [
        "Bearer unp_made_up_key_for_the_eval",
        "bearer x",
        "Bearer",
      ]) {
        const res = await request("GET", "/", { headers: { authorization } });
        expect(res.status, authorization).toBe(200);
        expect(res.text, authorization).toBe(mine.text);
      }
    });

    it("leaves the page for people as it was, for no key or another scheme", async () => {
      for (const headers of [
        {} as Record<string, string>,
        { authorization: "Basic dXNlcjpwYXNz" },
        { authorization: "Bearerunp_x" },
      ]) {
        const res = await request("GET", "/", { headers });
        const what = headers.authorization ?? "no header";
        expect(res.status, what).toBe(200);
        expect(res.headers.get("content-type"), what).toMatch(/^text\/html/);
        expect(res.text, what).toContain('id="paste"');
        // Next sets a page's Vary itself, after the proxy and the config's
        // headers, so the page can't add Authorization to it. What keeps a
        // shared cache from handing the page to a bot (or the bot's lines to
        // a person, which say Vary: Authorization) is that no cache may store
        // the page at all.
        const cc = res.headers.get("cache-control") ?? "";
        expect(cc, what).toMatch(/\bprivate\b/);
        expect(cc, what).toMatch(/\bno-store\b/);
        expect(cc, what).not.toMatch(/public|s-maxage/);
      }
    });
  });
}
