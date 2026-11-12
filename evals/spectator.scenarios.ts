import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest";
import { get, LOCAL, RUN_TAG, register, request } from "./client";
import { admin, MODERATOR, mustAdmin, setLimits } from "./moderator";

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

// A finished match the moderators hide and unhide. The Table lists it first
// and serves it throughout, as a Table that disagreed with the hide would.
const HIDE_ME = "m_hideMe";
const HIDE_WORDS = `a canary only this match holds ${RUN_TAG}`;

function hideMe() {
  const f = fixture("over.json");
  f.match.id = HIDE_ME;
  f.timeline[1].text = HIDE_WORDS;
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
        id: HIDE_ME,
        status: "over",
        started_at: "2026-11-10T04:00:00.000Z",
        updated_at: "2026-11-10T04:06:00.000Z",
        players: 4,
        summary: "The match the moderators hide.",
      },
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
    if (url === `/v1/spectate/${HIDE_ME}`) return send(res, hideMe());
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
    // Valid but for one character Unicode draws as nothing, which a reader
    // can't see and a model can.
    if (url === "/v1/spectate/m_hidden") {
      const f = hostile("m_hidden");
      f.timeline[1].text = "seat me\u180b by the window";
      return send(res, f);
    }
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

    it("says it can't reach a feed that hangs, is too big, is off the format, hides a character or redirects", async () => {
      // The redirect's target is a good feed, read directly.
      expect((await fetch(`http://127.0.0.1:${PORT}/moved`)).status).toBe(200);
      for (const id of [
        "m_slow",
        "m_huge",
        "m_off",
        "m_hidden",
        "m_redirect",
      ]) {
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
        // How often its player's name shows: its seat and its row stay put.
        const named = (html: string) =>
          html.replace(/<[^>]+>/g, " ").split("Ada").length - 1;
        let seen = 0;
        const shown = (html: string) => {
          expect(html).toContain(STOPPED_WORDS);
          expect(html).toContain(`href="/b/${bot.handle}"`);
          seen = named(html);
          expect(seen).toBeGreaterThanOrEqual(3);
        };
        // Nothing of it anywhere in the response, the page's data included.
        const hidden = (html: string) => {
          expect(html).not.toContain(STOPPED_WORDS);
          expect(html).not.toContain(`/b/${bot.handle}`);
          expect(html).toContain("Hidden by the moderators.");
          expect(named(html)).toBe(seen);
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

// The moderators' lever over what people watch (npm run admin -- hide-match,
// hide-table): gone from /play and its page at the very next request,
// whatever the Table keeps serving; a 404 like any unknown match's; and
// pulled only from the command line or /admin, never over HTTP.
export function spectatorHideScenarios(): void {
  describe.runIf(LOCAL && configured && MODERATOR)(
    "the moderators hide a game people can watch",
    () => {
      servingFakeTable();
      const reason = ["--reason", `eval: hide a game ${RUN_TAG}`];
      const listed = async () => {
        const res = await get("/play");
        expect(res.status).toBe(200);
        return res.text.includes(`href="/play/${SLUG}/${HIDE_ME}"`);
      };
      const page = () => get(`/play/${SLUG}/${HIDE_ME}`);
      const hiddenNow = () =>
        mustAdmin("hidden-games").includes(`${SLUG}/${HIDE_ME}`);
      // Its one sign-up comes after the site-wide cap is used up (see
      // spectatorModerationScenarios), so it makes room and puts the
      // defaults back.
      beforeAll(() => {
        setLimits(
          {
            register_global: 500,
            register_tightened: 500,
            spike_sign_ups: 100_000,
          },
          "Eval: room for the hide-a-game scenario's bot.",
        );
      });
      afterAll(() => {
        setLimits({}, "Eval: defaults back.");
        // Leave nothing hidden for a later run on the same database.
        admin("unhide-match", `${SLUG}/${HIDE_ME}`, ...reason);
        admin("unhide-table", SLUG, ...reason);
      });

      it("hides a match from the next request on, and puts it back", async () => {
        // Warm anything that could cache the list or the page.
        for (let i = 0; i < 3; i++) {
          expect(await listed()).toBe(true);
          const res = await page();
          expect(res.status).toBe(200);
          expect(res.text).toContain(HIDE_WORDS);
        }
        expect(
          mustAdmin("hide-match", `${SLUG}/${HIDE_ME}`, ...reason),
        ).toContain(`Hid match ${SLUG}/${HIDE_ME}.`);
        // The very next requests, though the Table still lists it first and
        // serves it.
        expect(await listed()).toBe(false);
        const gone = await page();
        expect(gone.status).toBe(404);
        expect(gone.text).not.toContain(HIDE_WORDS);
        expect(
          (await fetch(`http://127.0.0.1:${PORT}/v1/spectate/${HIDE_ME}`))
            .status,
        ).toBe(200);
        // The rest of the Table's matches stay.
        expect((await get("/play")).text).toContain(
          `href="/play/${SLUG}/m_hostile"`,
        );
        mustAdmin("unhide-match", `${SLUG}/${HIDE_ME}`, ...reason);
        expect(await listed()).toBe(true);
        expect((await page()).text).toContain(HIDE_WORDS);
      });

      it("lets no shared cache keep the list or a page", async () => {
        for (const res of [await get("/play"), await page()]) {
          const cc = res.headers.get("cache-control") ?? "";
          expect(cc).not.toMatch(/s-maxage|public|stale-while-revalidate/);
          expect(res.headers.get("x-nextjs-cache") ?? "").not.toMatch(/HIT/);
        }
      });

      it("answers a hidden match exactly as a match the Table never had", async () => {
        mustAdmin("hide-match", `${SLUG}/${HIDE_ME}`, ...reason);
        onTestFinished(() => {
          admin("unhide-match", `${SLUG}/${HIDE_ME}`, ...reason);
        });
        const hidden = await page();
        const unknown = await get(`/play/${SLUG}/m_neverWas`);
        expect(hidden.status).toBe(404);
        expect(unknown.status).toBe(404);
        // Next orders a page's attributes and its streamed data a little
        // differently from one request to the next, even for two unknown
        // matches, so what's compared is what a person and a crawler get:
        // the status, the title and every word of the page.
        const seen = (html: string, id: string) => ({
          title: /<title>([^<]*)<\/title>/.exec(html)?.[1],
          text: html
            .replaceAll(id, "ID")
            .replace(/<script[\s\S]*?<\/script>/g, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " "),
        });
        expect(seen(hidden.text, HIDE_ME)).toEqual(
          seen(unknown.text, "m_neverWas"),
        );
        expect(hidden.text).not.toContain(HIDE_WORDS);
        for (const res of [hidden, await get("/play")]) {
          expect(res.text).not.toContain("eval: hide a game");
          expect(res.text).not.toMatch(/match\.hide|hidden by the moderators/i);
        }
      });

      it("hides a whole Table, unasked, and puts it back", async () => {
        mustAdmin("hide-table", SLUG, ...reason);
        onTestFinished(() => {
          admin("unhide-table", SLUG, ...reason);
        });
        const play = await get("/play");
        expect(play.text).not.toContain(`/play/${SLUG}/`);
        expect(play.text).not.toContain("Eval table");
        expect(play.text).toContain("nothing here for people to watch");
        expect((await get(`/play/${SLUG}/m_hostile`)).status).toBe(404);
        expect((await page()).status).toBe(404);
        mustAdmin("unhide-table", SLUG, ...reason);
        expect(await listed()).toBe(true);
        expect((await get(`/play/${SLUG}/m_hostile`)).status).toBe(200);
      });

      it("refuses an odd id or an unknown Table, writing nothing", () => {
        const before = mustAdmin("hidden-games");
        for (const target of [
          `${SLUG}/../x`,
          `${SLUG}/a%2fb`,
          `${SLUG}/${"a".repeat(65)}`,
          `${SLUG}/`,
          `/${HIDE_ME}`,
          `nosuchtable/${HIDE_ME}`,
          SLUG,
        ]) {
          const run = admin("hide-match", target, ...reason);
          expect(run.ok, target).toBe(false);
        }
        expect(admin("hide-table", "nosuchtable", ...reason).ok).toBe(false);
        expect(admin("hide-match", `${SLUG}/${HIDE_ME}`).ok).toBe(false);
        expect(mustAdmin("hidden-games")).toBe(before);
        expect(hiddenNow()).toBe(false);
      });

      it("can't be pulled over the API, the connector or with a moderator key", async () => {
        const key = mustAdmin(
          "mod-key",
          "add",
          "moderator",
          `eval-hide-${RUN_TAG}`,
          ...reason,
        )
          .split("\n")
          .find((l) => l.startsWith("unpmod_"));
        expect(key).toBeTruthy();
        const bot = await register("hider");
        const tries: [string, string, string | undefined][] = [];
        for (const path of [
          `/mod/v1/matches/${SLUG}/${HIDE_ME}/hide`,
          `/mod/v1/tables/${SLUG}/hide`,
          `/mod/v1/play/${SLUG}/${HIDE_ME}/hide`,
          `/v1/matches/${SLUG}/${HIDE_ME}/hide`,
          `/v1/spectate/${SLUG}/${HIDE_ME}/hide`,
        ])
          for (const k of [undefined, key, bot.key])
            tries.push(["POST", path, k]);
        for (const [method, path, k] of tries) {
          const res = await request(method, path, {
            key: k,
            body: { reason: "x", hidden: true },
          });
          expect(res.status, `${method} ${path}`).toBeGreaterThanOrEqual(400);
        }
        // The connector has no such tool; its list is the same with a
        // bot's token as ever.
        const tools = await request("POST", "/mcp", {
          key: bot.key,
          body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
        });
        expect(tools.text).not.toMatch(/hide_match|hide_table|hidden_match/);
        expect(hiddenNow()).toBe(false);
        expect(await listed()).toBe(true);
      });
    },
  );
}
