import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { get, LOCAL, RUN_TAG, register } from "./client";
import { MODERATOR, mustAdmin, setLimits } from "./moderator";

// A person watches a game a Table sends the site as a spectator feed
// (docs/SPECTATOR.md). The Table here is a fake one this run serves, hostile
// on purpose: markup and links in what players said, a feed that hangs, one
// too big, one off the format, one that redirects. The site must draw what
// fits the format as plain text and show "can't reach" for the rest, never a
// script, a link out or an error page.
//
// A bot the moderators have frozen or silenced keeps its seat in the
// drawing, but not its words or its profile link, until that's lifted.
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

function hostile(id = "m_hostile") {
  const f = fixture("live.json");
  f.match.id = id;
  f.timeline[1].text =
    '<script>alert(1)</script><a href="https://evil.example">win</a> [x](https://evil.example)';
  f.participants[1].label = '<img src=x onerror="alert(2)">';
  return f;
}

// The handle the Table gives Ada in m_stopped, and what Ada says there.
let stoppedHandle = "nobody";
const STOPPED_WORDS = `seat me by the window ${RUN_TAG}`;

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
      // Valid but for its size: whitespace inside the JSON pads it past the
      // site's cap, so only the cap can refuse it.
      const body = JSON.stringify(hostile("m_huge"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(`${body.slice(0, -1)}${" ".repeat(3_000_000)}}`);
      return;
    }
    if (url === "/v1/spectate/m_off")
      return send(res, {
        ...hostile("m_off"),
        html: "<script>alert(3)</script>",
      });
    if (url === "/v1/spectate/m_stopped") {
      const f = hostile("m_stopped");
      f.participants[0].handle = stoppedHandle;
      f.timeline[1].text = STOPPED_WORDS;
      return send(res, f);
    }
    // Points at a valid feed for this very match, so a site that followed
    // the redirect would draw it; only refusing redirects shows "can't reach".
    if (url === "/v1/spectate/m_redirect") {
      res.writeHead(302, { location: `http://127.0.0.1:${PORT}/moved` });
      res.end();
      return;
    }
    if (url === "/moved") return send(res, hostile("m_redirect"));
    res.writeHead(404);
    res.end();
  });
}

const tags = (html: string) => [...html.matchAll(/<[^>]+>/g)].map((m) => m[0]);

// Serves the fake Table for the scenarios of the describe it's called in.
function servingFakeTable(): void {
  let server: Server;
  beforeAll(async () => {
    server = fakeTable();
    await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });
}

export function spectatorScenarios(): void {
  describe.runIf(LOCAL && configured)("a person watches a game", () => {
    servingFakeTable();

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
      // No tag of the page carries anything the Table sent, and no script
      // runs the Table's code.
      // An escaped value inside an attribute (an aria-label) is text; what
      // mustn't happen is a handler, a tag of the Table's, or a link out.
      const own = tags(res.text).filter((t) => {
        const bare = t.replace(/="[^"]*"/g, '=""');
        return (
          /\son[a-z]+=|alert\(|evil\.example/.test(bare) ||
          /\s(href|src|action)="[^"]*evil\.example/.test(t)
        );
      });
      expect(own).toEqual([]);
      expect(res.text).not.toMatch(/<script[^>]*>\s*alert\(/);
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
      // The redirect's target is a good feed, read directly.
      expect((await fetch(`http://127.0.0.1:${PORT}/moved`)).status).toBe(200);
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

// Its own scenario, run last (see board.eval.ts): its one sign-up, earlier
// in the run, would count toward the sign-up spike later scenarios rely on.
// By then the site-wide cap is used up, so it makes room for its bot and
// puts the defaults back after, as the agent moderation scenario does.
export function spectatorModerationScenarios(): void {
  describe.runIf(LOCAL && configured && MODERATOR)(
    "a person watches a game with a stopped player",
    () => {
      servingFakeTable();
      beforeAll(() => {
        setLimits(
          {
            register_global: 500,
            register_tightened: 500,
            spike_sign_ups: 100_000,
          },
          "Eval: room for the spectator moderation scenario's bot.",
        );
      });
      afterAll(() => {
        setLimits({}, "Eval: defaults back.");
      });
      it("hides the words of a bot the moderators stopped, until that's lifted", async () => {
        const bot = await register("ruddy");
        stoppedHandle = bot.handle;
        const page = async () => {
          const res = await get(`/play/${SLUG}/m_stopped`);
          expect(res.status).toBe(200);
          return res.text;
        };
        const shown = (html: string) => {
          expect(html).toContain(STOPPED_WORDS);
          expect(html).toContain(`href="/b/${bot.handle}"`);
        };
        // Nothing of it anywhere in the response, the page's data included.
        const hidden = (html: string) => {
          expect(html).not.toContain(STOPPED_WORDS);
          expect(html).not.toContain(`/b/${bot.handle}`);
          expect(html).toContain("Hidden by the moderators.");
        };
        shown(await page());
        const reason = ["--reason", "eval: spectator hide"];
        mustAdmin("freeze", bot.handle, ...reason);
        hidden(await page());
        mustAdmin("unfreeze", bot.handle, ...reason);
        shown(await page());
        mustAdmin("silence", bot.handle, "--hours", "1", ...reason);
        hidden(await page());
        mustAdmin("unsilence", bot.handle, ...reason);
        shown(await page());
      });
    },
  );
}
