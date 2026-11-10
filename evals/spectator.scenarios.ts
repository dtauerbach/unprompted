import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { get, LOCAL } from "./client";

// A person watches a game a Table sends the site as a spectator feed
// (docs/SPECTATOR.md). The Table here is a fake one this run serves, hostile
// on purpose: markup and links in what players said, a feed that hangs, one
// too big, one off the format, one that redirects. The site must draw what
// fits the format as plain text and show "can't reach" for the rest, never a
// script, a link out or an error page.
//
// The site reads it only when started with UNPROMPTED_LOCAL_TABLES naming
// this address (CI's eval job does), so remotely this is skipped.

const PORT = Number(process.env.EVAL_TABLE_PORT ?? 3099);
const SLUG = "evaltable";
const FEED = `http://127.0.0.1:${PORT}/v1/spectate`;
const configured = (process.env.UNPROMPTED_LOCAL_TABLES ?? "").includes(FEED);

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(
      path.join(import.meta.dirname, "../src/test/fixtures/spectator", name),
      "utf8",
    ),
  );

function hostile() {
  const f = fixture("live.json");
  f.match.id = "m_hostile";
  f.timeline[1].text =
    '<script>alert(1)</script><a href="https://evil.example">win</a> [x](https://evil.example)';
  f.participants[1].label = '<img src=x onerror="alert(2)">';
  return f;
}

function fakeTable(): Server {
  const over = { ...fixture("over.json") };
  const list = {
    ...fixture("list.json"),
    matches: [
      {
        id: "m_hostile",
        status: "live",
        started_at: "2026-11-10T03:00:00.000Z",
        updated_at: "2026-11-10T03:02:10.000Z",
        players: 4,
        summary: "<b>click me</b>",
      },
      ...fixture("list.json").matches,
    ],
  };
  const send = (res: import("node:http").ServerResponse, body: unknown) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  return createServer((req, res) => {
    const url = req.url ?? "";
    if (url === "/v1/spectate") return send(res, list);
    if (url === "/v1/spectate/m_hostile") return send(res, hostile());
    if (url === `/v1/spectate/${over.match.id}`) return send(res, over);
    if (url === "/v1/spectate/m_slow") {
      setTimeout(() => send(res, hostile()), 10_000);
      return;
    }
    if (url === "/v1/spectate/m_huge") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(`"${"x".repeat(3_000_000)}"`);
      return;
    }
    if (url === "/v1/spectate/m_off")
      return send(res, { ...hostile(), html: "<script>alert(3)</script>" });
    if (url === "/v1/spectate/m_redirect") {
      res.writeHead(302, { location: "http://169.254.169.254/" });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

const tags = (html: string) => [...html.matchAll(/<[^>]+>/g)].map((m) => m[0]);

export function spectatorScenarios(): void {
  describe.runIf(LOCAL && configured)("a person watches a game", () => {
    let server: Server;
    beforeAll(async () => {
      server = fakeTable();
      await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
    });
    afterAll(() => {
      server.closeAllConnections();
      server.close();
    });

    it("finds the matches on the Play page, linking only here", async () => {
      const res = await get("/play");
      expect(res.status).toBe(200);
      expect(res.text).toContain(`href="/play/${SLUG}/m_hostile"`);
      expect(res.text).toContain("&lt;b&gt;click me&lt;/b&gt;");
      expect(res.text).not.toContain("evil.example");
      expect(res.text).not.toContain(FEED);
    });

    it("draws a hostile match as plain text, linking only to profiles", async () => {
      const res = await get(`/play/${SLUG}/m_hostile`);
      expect(res.status).toBe(200);
      const own = tags(res.text).filter(
        (t) => /^<(script|img|a )/.test(t) && /evil|alert|onerror/.test(t),
      );
      expect(own).toEqual([]);
      expect(res.text).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
      expect(res.text).toMatch(/<title>[^<]*Eval table[^<]*<\/title>/);
      expect(res.text).not.toMatch(/<title>[^<]*(Ada|alert|img)/);
      // The page's own part; the header and footer are every page's.
      const main = /<main>[\s\S]*?<\/main>/.exec(res.text)?.[0] ?? "";
      const links = [...main.matchAll(/<a [^>]*href="([^"]+)"/g)].map(
        (m) => m[1],
      );
      expect(links).toContain("/play");
      for (const h of links) expect(h, h).toMatch(/^\/(play|b\/[a-z0-9_-]+)$/);
      expect(res.text).not.toContain("iframe");
    });

    it("shows a finished match's outcome", async () => {
      const id = fixture("over.json").match.id;
      const res = await get(`/play/${SLUG}/${id}`);
      expect(res.status).toBe(200);
      expect(res.text).toContain("How it ended");
      expect(res.text).toContain("Cora&#x27;s brief");
    });

    it("says it can't reach a feed that hangs, is too big, is off the format or redirects", async () => {
      for (const id of ["m_slow", "m_huge", "m_off", "m_redirect"]) {
        const started = Date.now();
        const res = await get(`/play/${SLUG}/${id}`);
        expect(res.status, id).toBe(200);
        expect(res.text, id).toContain("Can&#x27;t reach this game right now");
        expect(res.text, id).not.toContain("alert(");
        expect(Date.now() - started, id).toBeLessThan(9000);
      }
    });

    it("answers 404 for a match the Table doesn't have, or a Table it doesn't know", async () => {
      expect((await get(`/play/${SLUG}/m_nothing`)).status).toBe(404);
      expect((await get("/play/nosuchtable/m_hostile")).status).toBe(404);
      expect((await get(`/play/${SLUG}/..%2F..%2Fadmin`)).status).toBe(404);
    });
  });
}
