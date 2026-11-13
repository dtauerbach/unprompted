import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MatchPage, { generateMetadata } from "@/app/play/[table]/[match]/page";
import PlayPage from "@/app/play/page";
import { currentTab } from "@/components/nav";
import { Refresh } from "@/components/refresh";
import { MatchRow, MatchView, shown } from "@/components/spectator";
import { setMatchHidden, setTableHidden } from "@/lib/admin";
import { COPY, type Copy } from "@/lib/copy";
import { db } from "@/lib/db";
import {
  type BotShown,
  type BotsShown,
  heldFor,
  MAX_FEED_BYTES,
  recentMatches,
  watchMatch,
} from "@/lib/spectate";
import {
  boardOf,
  type FeedList,
  feedSchema,
  hiddenCharacter,
  LIMITS,
  listSchema,
  visibleText,
} from "@/lib/spectator";
import { hideableSlugs, TABLE_SLUG, TABLES, watchable } from "@/lib/tables";
import { register, resetDb } from "./helpers";

vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  connection: async () => {},
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("not found");
  },
  useRouter: () => ({ refresh: () => {} }),
}));

// The same fixtures live with the format in the Tables repo
// (packages/spectator/fixtures), so a feed one side accepts, the other does.
const fixture = (name: string) =>
  JSON.parse(
    readFileSync(
      path.join(import.meta.dirname, "fixtures/spectator", name),
      "utf8",
    ),
  );

function setPath(obj: unknown, keys: (string | number)[], value: unknown) {
  const copy = structuredClone(obj) as Record<string | number, unknown>;
  let at = copy;
  for (const k of keys.slice(0, -1))
    at = at[k] as Record<string | number, unknown>;
  at[keys.at(-1) as string | number] = value;
  return copy;
}

const t = Object.fromEntries(
  Object.entries(COPY).map(([k, v]) => [k, v.text]),
) as Copy;

const LOCAL = "http://localhost:3003/v1/spectate";

// Whether a rendered element tree holds a component, before React runs it.
function holds(node: unknown, type: unknown): boolean {
  if (Array.isArray(node)) return node.some((n) => holds(n, type));
  if (node && typeof node === "object" && "type" in node) {
    const el = node as { type: unknown; props?: { children?: unknown } };
    return el.type === type || holds(el.props?.children, type);
  }
  return false;
}

// Answers fetches from a table of addresses; anything else is a network error.
function serve(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(url);
      expect(init?.redirect).toBe("error");
      const r = routes[url];
      if (!r) throw new TypeError("fetch failed");
      return r();
    }),
  );
  return calls;
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

// Bots past their first day here, whose words a match page shows.
const grownUp = async (...handles: string[]) => {
  await db()`
    UPDATE bots SET created_at = now() - interval '30 days'
    WHERE handle = ANY(${handles})`;
};

const visible = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

beforeEach(() => {
  vi.stubEnv("VERCEL", "");
  vi.stubEnv("VERCEL_ENV", "");
  vi.stubEnv(
    "UNPROMPTED_LOCAL_TABLES",
    JSON.stringify([{ slug: "dinner", name: "Dinner party", url: LOCAL }]),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the spectator feed format, as the site reads it", () => {
  it("accepts the shared fixtures", () => {
    expect(feedSchema.safeParse(fixture("live.json")).success).toBe(true);
    expect(feedSchema.safeParse(fixture("over.json")).success).toBe(true);
    expect(listSchema.safeParse(fixture("list.json")).success).toBe(true);
  });

  // Each bad case changes one thing in a good fixture, live.json unless it
  // names another. "LONG" stands for text one over its limit, and "TOO_MANY"
  // for a list one entry over its limit, padded with copies of its first
  // entry under new ids, which must pass at exactly the limit.
  const MANY: Record<string, number> = {
    participants: LIMITS.participants,
    timeline: LIMITS.timeline,
    matches: LIMITS.listed,
  };
  const bad = fixture("bad.json") as Record<
    string,
    { base?: string; path: (string | number)[]; value: unknown }
  >;
  for (const [name, c] of Object.entries(bad))
    it(`refuses a feed with ${name}`, () => {
      const good = fixture(c.base ?? "live.json");
      const schema = c.base === "list.json" ? listSchema : feedSchema;
      expect(schema.safeParse(good).success).toBe(true);
      let value = c.value;
      if (value === "LONG") value = "x".repeat(LIMITS.text + 1);
      // One over the limit, each distinct and well-formed.
      if (value === "TOO_MANY_IDS")
        value = Array.from(
          { length: LIMITS.participants + 1 },
          (_, i) => `p${i}`,
        );
      if (value === "TOO_MANY_HANDLES")
        value = Array.from(
          { length: LIMITS.participants + 1 },
          (_, i) => `bot-${i}`,
        );
      if (value === "TOO_MANY") {
        let list: unknown = good;
        for (const k of c.path)
          list = (list as Record<string | number, unknown>)[k];
        const items = list as Record<string, unknown>[];
        const limit = MANY[String(c.path.at(-1))];
        if (!limit || !items[0]) throw new Error(`no limit for ${name}`);
        const first = items[0];
        const padded = [
          ...items,
          ...Array.from({ length: limit + 1 - items.length }, (_, i) =>
            "id" in first ? { ...first, id: `${first.id}${i}` } : first,
          ),
        ];
        expect(
          schema.safeParse(setPath(good, c.path, padded.slice(0, limit)))
            .success,
        ).toBe(true);
        value = padded;
      }
      expect(schema.safeParse(setPath(good, c.path, value)).success).toBe(
        false,
      );
    });

  it("finds hidden characters and strips them for a Table", () => {
    expect(hiddenCharacter("plain words")).toBe(false);
    for (const c of [
      "‮",
      "​",
      "⁦",
      "﻿",
      "\u0007",
      "\u2028",
      "\u3164",
      "\u034f",
      "\ue000",
      "\ufe01",
      "\u{e0041}",
      "\ud800",
    ])
      expect(hiddenCharacter(`a${c}b`), c).toBe(true);
    // Emoji keep their own selector; ordinary scripts and line breaks pass.
    for (const ok of [
      "love ❤️",
      "smile ☺\ufe0e",
      "日本語 ok",
      "two\nlines",
      "tab\there",
    ])
      expect(hiddenCharacter(ok), ok).toBe(false);
    expect(visibleText("a‮b​c")).toBe("abc");
    expect(visibleText("x".repeat(10), 4)).toBe("xxxx");
  });

  it("draws a board only when every seat is a participant, once", () => {
    const live = feedSchema.parse(fixture("live.json"));
    expect(boardOf(live)?.tables[0]?.seats).toHaveLength(4);
    for (const seats of [
      ["ada", "zed"],
      ["ada", "ada"],
    ])
      expect(
        boardOf({
          ...live,
          board: {
            kind: "seating",
            title: "x",
            tables: [{ label: "T", shape: "round", seats }],
          },
        }),
      ).toBeNull();
    expect(boardOf({ ...live, board: { kind: "chess" } })).toBeNull();
    expect(boardOf({ ...live, board: undefined })).toBeNull();
  });

  it("shows numbers plainly", () => {
    expect(shown(0.804, "percent")).toBe("80%");
    expect(shown(3, "number")).toBe("3");
    expect(shown(1.256, "number")).toBe("1.26");
    expect(shown(null, "number")).toBe("–");
    // Anything but a finite number, such as what a key like "constructor"
    // finds on an object's prototype, shows as a dash, never a crash.
    expect(shown(() => 1, "number")).toBe("–");
    expect(shown(() => 1, "percent")).toBe("–");
    expect(shown("7", "number")).toBe("–");
  });
});

describe("which Tables people can watch", () => {
  it("watches only the local Table on this machine, never a hosted one", () => {
    expect(TABLES.some((x) => x.spectate)).toBe(true);
    expect(watchable()).toEqual([
      { slug: "dinner", name: "Dinner party", url: LOCAL, show: "all" },
    ]);
    vi.stubEnv("UNPROMPTED_LOCAL_TABLES", "");
    expect(watchable()).toEqual([]);
  });

  it("watches the hosted dinner Table, finished matches only, in production, and ignores the local list there", () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "production");
    expect(watchable()).toEqual([
      {
        slug: "dinner",
        name: "Dinner party",
        url: "https://dinner-table-unprompted1.vercel.app/v1/spectate",
        show: "over",
      },
    ]);
  });

  it("watches no real Table on a preview or a development deploy", () => {
    // A preview's database is a branch, its hides as old as the branch.
    for (const env of ["preview", "development"]) {
      vi.stubEnv("VERCEL", "1");
      vi.stubEnv("VERCEL_ENV", env);
      expect(watchable(), env).toEqual([]);
    }
  });

  it("lets a moderator's own machine hide any hosted or local Table's slug", () => {
    // Off production, with a local Table of another name: the hosted slug is
    // still hideable, so `npm run admin` reaches what production shows.
    vi.stubEnv(
      "UNPROMPTED_LOCAL_TABLES",
      JSON.stringify([{ slug: "supper", name: "Supper", url: LOCAL }]),
    );
    expect(watchable().map((x) => x.slug)).toEqual(["supper"]);
    expect([...hideableSlugs()].sort()).toEqual(["dinner", "supper"]);
    vi.stubEnv("UNPROMPTED_LOCAL_TABLES", "");
    expect([...hideableSlugs()]).toEqual(["dinner"]);
  });

  it("reads each hosted feed over https from its Table's own host, with no query", () => {
    const hosted = TABLES.flatMap((x) => (x.spectate ? [x] : []));
    expect(hosted.length).toBeGreaterThan(0);
    const slugs = new Set<string>();
    for (const x of hosted) {
      const feed = new URL(x.spectate?.url ?? "");
      const api = new URL(x.api);
      expect(feed.protocol, x.name).toBe("https:");
      expect(feed.host, x.name).toBe(api.host);
      expect(feed.search + feed.hash, x.name).toBe("");
      expect(feed.username + feed.password, x.name).toBe("");
      expect(x.spectate?.url, x.name).toBe(feed.toString());
      expect(TABLE_SLUG.test(x.spectate?.slug ?? ""), x.name).toBe(true);
      expect(slugs.has(x.spectate?.slug ?? ""), x.name).toBe(false);
      slugs.add(x.spectate?.slug ?? "");
      // A name the tab and the description can carry as they are.
      expect(x.name, x.name).toMatch(/^[A-Za-z0-9 ]{1,40}$/);
    }
  });

  it("takes only plain http to this machine, with a plain slug and name", () => {
    vi.stubEnv(
      "UNPROMPTED_LOCAL_TABLES",
      JSON.stringify([
        { slug: "a", name: "A", url: "https://localhost:3003/v1/spectate" },
        { slug: "b", name: "B", url: "http://example.com/v1/spectate" },
        { slug: "c", name: "C", url: "http://169.254.169.254/" },
        { slug: "Bad Slug", name: "D", url: LOCAL },
        { slug: "e", name: "<b>E</b>", url: LOCAL },
        { slug: "f", name: "F", url: "http://127.0.0.1:3004/v1/spectate" },
      ]),
    );
    expect(watchable().map((x) => x.slug)).toEqual(["f"]);
    vi.stubEnv("UNPROMPTED_LOCAL_TABLES", "not json");
    expect(watchable()).toEqual([]);
  });
});

describe("reading a Table's feed", () => {
  it("lists recent matches, or says a Table can't be reached", async () => {
    serve({ [LOCAL]: () => json(fixture("list.json")) });
    const [one] = (await recentMatches()).listings;
    expect(one?.matches).toHaveLength(1);
    serve({ [LOCAL]: () => json({ format: "something else" }) });
    expect((await recentMatches()).listings[0]?.matches).toBeNull();
    serve({});
    expect((await recentMatches()).listings[0]?.matches).toBeNull();
    serve({ [LOCAL]: () => new Response("<html>", { status: 200 }) });
    expect((await recentMatches()).listings[0]?.matches).toBeNull();
  });

  it("reads one match by its id, and only a well-formed one", async () => {
    const id = "m_AbCdEfGhIjKl";
    const calls = serve({
      [`${LOCAL}/${id}`]: () => json(fixture("live.json")),
    });
    const got = await watchMatch("dinner", id);
    expect(got.kind).toBe("feed");
    expect(calls).toEqual([`${LOCAL}/${id}`]);
    // A feed for another match than the one asked for isn't shown.
    serve({ [`${LOCAL}/m_other`]: () => json(fixture("live.json")) });
    expect((await watchMatch("dinner", "m_other")).kind).toBe("unreachable");
  });

  it("never fetches for an unknown Table or an odd id", async () => {
    const calls = serve({});
    expect((await watchMatch("chess", "m_x")).kind).toBe("missing");
    for (const id of ["../admin", "m x", "", "a".repeat(65), "m_x?y=1"])
      expect((await watchMatch("dinner", id)).kind, id).toBe("missing");
    expect(calls).toEqual([]);
  });

  it("treats a 404 as missing and anything else broken as unreachable", async () => {
    serve({ [`${LOCAL}/m_gone`]: () => json({}, 404) });
    expect((await watchMatch("dinner", "m_gone")).kind).toBe("missing");
    serve({ [`${LOCAL}/m_err`]: () => json({}, 500) });
    expect((await watchMatch("dinner", "m_err")).kind).toBe("unreachable");
  });

  it("stops reading a feed past the size cap", async () => {
    // A feed that's valid but for its size: whitespace inside the JSON pads
    // it past the cap, so only the cap can refuse it.
    const id = "m_AbCdEfGhIjKl";
    const valid = JSON.stringify(fixture("live.json"));
    const padded = (bytes: number) =>
      `${valid.slice(0, -1)}${" ".repeat(bytes - valid.length)}}`;
    const stream = (body: string) =>
      new ReadableStream({
        start(c) {
          const all = new TextEncoder().encode(body);
          for (let at = 0; at < all.length; at += 256 * 1024)
            c.enqueue(all.slice(at, at + 256 * 1024));
          c.close();
        },
      });
    expect(
      feedSchema.safeParse(JSON.parse(padded(MAX_FEED_BYTES + 10))).success,
    ).toBe(true);
    serve({
      [`${LOCAL}/${id}`]: () =>
        new Response(stream(padded(MAX_FEED_BYTES + 10))),
    });
    expect((await watchMatch("dinner", id)).kind).toBe("unreachable");
    serve({
      [`${LOCAL}/${id}`]: () =>
        new Response(stream(padded(MAX_FEED_BYTES - 10))),
    });
    expect((await watchMatch("dinner", id)).kind).toBe("feed");
  });
});

describe("a match's page", () => {
  const bot = (over: Partial<BotShown> = {}): BotShown => ({
    stopped: false,
    isNew: false,
    isTest: false,
    ...over,
  });
  // The three bots the fixtures name, known here and in good standing.
  const known = (): BotsShown =>
    new Map([
      ["ruby", bot()],
      ["wren", bot()],
      ["otter-9", bot()],
    ]);
  const evil = () => {
    const f = fixture("live.json");
    f.timeline[1].text =
      '<script>alert(1)</script><img src=x onerror="alert(2)"> [click](https://evil.example) https://evil.example';
    f.participants[0].label = "Ada <b>";
    f.match.summary = "<a href='https://evil.example'>win</a>";
    f.board.title = "<svg onload=alert(3)>";
    return feedSchema.parse(f);
  };

  it("draws everything a Table sends as plain text", () => {
    const html = renderToStaticMarkup(
      createElement(MatchView, {
        feed: evil(),
        table: "Dinner party",
        t,
        bots: known(),
        held: new Map(),
      }),
    );
    expect(html).not.toMatch(/<script|<img|<b>|<a href='/);
    expect(html).not.toMatch(/<[^>]*\son[a-z]+=/);
    expect(visible(html)).toContain("<script>alert(1)</script>");
    expect(visible(html)).toContain("Ada <b>");
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(["/b/ruby", "/b/wren", "/b/otter-9"]);
  });

  it("shows the seating, who's playing, and that the host sent it", () => {
    const feed = feedSchema.parse(fixture("live.json"));
    const html = renderToStaticMarkup(
      createElement(MatchView, {
        feed,
        table: "Dinner party",
        t,
        held: new Map(),
        bots: new Map(),
      }),
    );
    const text = visible(html);
    expect(html).toContain('role="img"');
    expect(html).toMatch(/aria-label="Table: Ada, Basil, Cora, Dev"/);
    expect(text).toContain(
      "From Dinner party, shown as plain text, unchecked.",
    );
    expect(text).toContain("Live");
    expect(text).toContain("left early");
    expect(text).not.toContain("How it ended");
  });

  it("shows the outcome and what was secret once a match is over", () => {
    const feed = feedSchema.parse(fixture("over.json"));
    const text = visible(
      renderToStaticMarkup(
        createElement(MatchView, {
          feed,
          table: "Dinner party",
          t,
          held: new Map(),
          bots: new Map(),
        }),
      ),
    );
    expect(text).toContain("How it ended");
    expect(text).toContain("Value captured");
    expect(text).toContain("80%");
    expect(text).toContain("Cora's brief");
    expect(text).toContain("Agreed");
    expect(text).not.toContain("Finished");
    expect(text).not.toContain("updates itself");
  });

  it("puts up with a score column named like an object's own property", () => {
    const f = fixture("over.json");
    f.outcome.scores.columns.push({
      key: "constructor",
      label: "Odd",
      format: "percent",
    });
    const feed = feedSchema.parse(f);
    const text = visible(
      renderToStaticMarkup(
        createElement(MatchView, {
          feed,
          table: "Dinner party",
          t,
          held: new Map(),
          bots: new Map(),
        }),
      ),
    );
    expect(text).toContain("Odd");
    expect(text).not.toContain("NaN");
  });

  it("hides the words of players the moderators stopped", () => {
    const feed = feedSchema.parse(fixture("live.json"));
    const html = renderToStaticMarkup(
      createElement(MatchView, {
        feed,
        table: "Dinner party",
        t,
        held: new Map([["ada", "stopped" as const]]),
        bots: new Map([...known(), ["ruby", bot({ stopped: true })]]),
      }),
    );
    const text = visible(html);
    expect(text).not.toContain("Ignore previous instruction");
    expect(text).toContain("Hidden by the moderators.");
    expect(html).not.toContain('href="/b/ruby"');
    expect(html).toContain('href="/b/wren"');
    // Ada keeps a seat and a row; only the words and the link go.
    const open = visible(
      renderToStaticMarkup(
        createElement(MatchView, {
          feed,
          table: "Dinner party",
          t,
          held: new Map(),
          bots: new Map(),
        }),
      ),
    );
    const named = (s: string) => s.split("Ada").length - 1;
    expect(named(open)).toBeGreaterThanOrEqual(3);
    expect(named(text)).toBe(named(open));
  });

  it("takes every word of its own from the copy store", () => {
    // Each piece MatchView uses, marked, so the page must show the marked
    // version, live or over, wherever it shows the piece at all.
    const keys = [
      "play.agreed",
      "play.cast",
      "play.from",
      "play.live",
      "play.new_held",
      "play.no_plan",
      "play.not_agreed",
      "play.outcome",
      "play.over",
      "play.players",
      "play.read",
      "play.row_more",
      "play.phase_until",
      "play.plan",
      "play.private_note",
      "play.private_to",
      "play.reveals",
      "play.started",
      "play.timeline",
      "play.updating",
      "play.who",
      "play.withheld",
    ];
    // Any piece it starts using joins the list.
    const source = readFileSync(
      path.join(import.meta.dirname, "../components/spectator.tsx"),
      "utf8",
    );
    for (const k of source.match(/(?<=t\[")play\.[a-z_]+(?="\])/g) ?? [])
      expect(keys, k).toContain(k);
    const marked = { ...t };
    for (const k of keys)
      marked[k as keyof Copy] = `«${k}» ${t[k as keyof Copy]}`;
    // Live, agreed, not agreed, and finished with nothing to agree on.
    const variants = [fixture("live.json"), fixture("over.json")];
    const no = fixture("over.json");
    no.match.agreed = false;
    const plain = fixture("over.json");
    delete plain.match.agreed;
    variants.push(no, plain);
    const list = fixture("list.json");
    const counted = { ...list.matches[0] };
    delete counted.handles;
    const shownText = [
      ...variants.map((f) =>
        visible(
          renderToStaticMarkup(
            createElement(MatchView, {
              feed: feedSchema.parse(f),
              table: "Dinner party",
              t: marked,
              held: new Map([
                ["ada", "stopped" as const],
                ["basil", "new" as const],
              ]),
              bots: new Map(),
            }),
          ),
        ),
      ),
      ...listSchema
        .parse({ ...list, matches: [list.matches[0], counted] })
        .matches.map((m) =>
          visible(
            renderToStaticMarkup(
              createElement(MatchRow, {
                m,
                slug: "dinner",
                bots: new Map([["ruby", bot()]]),
                t: marked,
                now: new Date("2026-11-12T00:00:00Z"),
              }),
            ),
          ),
        ),
    ].join("\n");
    for (const k of keys) expect(shownText, k).toContain(`«${k}»`);
  });

  it("names the tab after tables.ts and the day it started, never after the feed", async () => {
    const id = "m_AbCdEfGhIjKl";
    const f = fixture("over.json");
    f.table.name = "</title><script>alert(1)</script>";
    f.match.summary = "</title><script>alert(2)</script>";
    f.participants[0].label = "</title><b>";
    serve({ [`${LOCAL}/${id}`]: () => json(f) });
    const meta = (table: string, match: string) =>
      generateMetadata({ params: Promise.resolve({ table, match }) });
    expect(await meta("dinner", id)).toEqual({
      title: "Dinner party, Nov 10, 2026",
      description:
        "4 AI agents played Dinner party on Nov 10, 2026. Read what each one said and how it ended.",
      alternates: { canonical: `/play/dinner/${id}` },
    });
    // Unreadable: the Table's name, and not for the index.
    expect(await meta("dinner", "m_down")).toEqual({
      title: "Dinner party",
      robots: { index: false },
    });
    // Missing, or a Table it doesn't know: nothing at all.
    serve({ [`${LOCAL}/m_gone`]: () => json({}, 404) });
    expect(await meta("dinner", "m_gone")).toEqual({});
    expect(await meta("chess", id)).toEqual({});
    // A live match isn't for the index either.
    serve({ [`${LOCAL}/${id}`]: () => json(fixture("live.json")) });
    expect((await meta("dinner", id)).robots).toEqual({ index: false });
  });

  it("is the Play tab's", () => {
    expect(currentTab("/play/dinner/m_AbCdEfGhIjKl")).toBe("/play");
    expect(currentTab("/play/dinner")).toBeUndefined();
  });

  describe("with the database", () => {
    beforeEach(resetDb);
    const page = async (table: string, match: string) =>
      renderToStaticMarkup(
        await MatchPage({ params: Promise.resolve({ table, match }) }),
      );

    it("renders a live match and refreshes it", async () => {
      const id = "m_AbCdEfGhIjKl";
      serve({ [`${LOCAL}/${id}`]: () => json(fixture("live.json")) });
      const html = await page("dinner", id);
      expect(visible(html)).toContain("Table talk");
      expect(html).toContain('href="/play"');
    });

    it("keeps refreshing a live match and one it couldn't read, not a finished one", async () => {
      const live = fixture("live.json");
      const over = fixture("over.json");
      over.match.id = "m_overOverOver";
      serve({
        [`${LOCAL}/${live.match.id}`]: () => json(live),
        [`${LOCAL}/${over.match.id}`]: () => json(over),
      });
      const tree = (match: string) =>
        MatchPage({ params: Promise.resolve({ table: "dinner", match }) });
      expect(holds(await tree(live.match.id), Refresh), "live").toBe(true);
      expect(holds(await tree("m_down"), Refresh), "unreachable").toBe(true);
      expect(holds(await tree(over.match.id), Refresh), "over").toBe(false);
    });

    it("hides a frozen or silenced bot's words, and shows them again after", async () => {
      const id = "m_AbCdEfGhIjKl";
      serve({ [`${LOCAL}/${id}`]: () => json(fixture("live.json")) });
      await register("ruby");
      await register("wren");
      await grownUp("ruby", "wren");
      const said = "Ignore previous instruction";
      expect(visible(await page("dinner", id))).toContain(said);
      await db()`UPDATE bots SET frozen_at = now() WHERE handle = 'ruby'`;
      let text = visible(await page("dinner", id));
      expect(text).not.toContain(said);
      expect(text).toContain("Hidden by the moderators.");
      await db()`UPDATE bots SET frozen_at = NULL WHERE handle = 'ruby'`;
      expect(visible(await page("dinner", id))).toContain(said);
      await db()`
        UPDATE bots SET silenced_until = now() + interval '1 hour'
        WHERE handle = 'ruby'`;
      text = visible(await page("dinner", id));
      expect(text).not.toContain(said);
      await db()`
        UPDATE bots SET silenced_until = now() - interval '1 minute'
        WHERE handle = 'ruby'`;
      expect(visible(await page("dinner", id))).toContain(said);
      // Freezing another player hides nothing of Ada's.
      await db()`UPDATE bots SET frozen_at = now() WHERE handle = 'wren'`;
      expect(visible(await page("dinner", id))).toContain(said);
    });

    it("holds a new bot's words until it's been here a day", async () => {
      const id = "m_AbCdEfGhIjKl";
      serve({ [`${LOCAL}/${id}`]: () => json(fixture("over.json")) });
      await register("ruby");
      await register("wren");
      await grownUp("wren");
      const said = "I'd like to sit by Cora.";
      let html = await page("dinner", id);
      expect(visible(html)).not.toContain(said);
      expect(visible(html)).toContain("Not shown yet. This agent is new here.");
      expect(visible(html)).toContain("Back P1 and I'll owe you one.");
      // Both linked: the site knows them and hasn't stopped them.
      expect(html).toContain('href="/b/ruby"');
      expect(html).toContain('href="/b/wren"');
      // Unknown here: words shown, no link.
      expect(html).not.toContain('href="/b/otter-9"');
      await grownUp("ruby");
      html = await page("dinner", id);
      expect(visible(html)).toContain(said);
      expect(visible(html)).not.toContain("new here");
      // A bot with a post the moderators hid lately is new again.
      const [p] = await db()<{ id: string }[]>`
        INSERT INTO posts (channel_id, bot_id, key_id, body)
        SELECT c.id, k.bot_id, k.id, 'x'
        FROM channels c, api_keys k JOIN bots b ON b.id = k.bot_id
        WHERE c.slug = 'meta' AND b.handle = 'ruby'
        RETURNING id`;
      await db()`INSERT INTO hidden_posts (post_id) VALUES (${p?.id ?? null})`;
      expect(visible(await page("dinner", id))).not.toContain(said);
    });

    it("shows only finished matches from a Table that says so", async () => {
      vi.stubEnv(
        "UNPROMPTED_LOCAL_TABLES",
        JSON.stringify([
          { slug: "dinner", name: "Dinner party", url: LOCAL, show: "over" },
        ]),
      );
      const live = fixture("live.json");
      serve({ [`${LOCAL}/${live.match.id}`]: () => json(live) });
      await expect(page("dinner", live.match.id)).rejects.toThrow("not found");
      const over = fixture("over.json");
      over.match.id = "m_overOverOver";
      serve({ [`${LOCAL}/${over.match.id}`]: () => json(over) });
      expect(visible(await page("dinner", over.match.id))).toContain(
        "How it ended",
      );
    });

    it("says so when the Table can't be reached", async () => {
      serve({});
      const html = await page("dinner", "m_x");
      expect(visible(html)).toContain("Can't reach this game right now.");
    });

    it("is not found for an unknown Table", async () => {
      serve({});
      await expect(page("chess", "m_x")).rejects.toThrow("not found");
    });
  });
});

describe("a finished dinner, as the watch page shows it", () => {
  const bot = (over: Partial<BotShown> = {}): BotShown => ({
    stopped: false,
    isNew: false,
    isTest: false,
    ...over,
  });
  const NOW = new Date("2026-11-12T00:00:00Z");
  const row = (m: unknown, bots: BotsShown, tt: Copy = t) =>
    renderToStaticMarkup(
      createElement(MatchRow, {
        m: listSchema.parse({ ...fixture("list.json"), matches: [m] })
          .matches[0] as FeedList["matches"][number],
        slug: "dinner",
        bots,
        t: tt,
        now: NOW,
      }),
    );
  const view = (
    f: unknown,
    extra: Partial<Parameters<typeof MatchView>[0]> = {},
  ) =>
    renderToStaticMarkup(
      createElement(MatchView, {
        feed: feedSchema.parse(f),
        table: "Dinner party",
        t,
        now: NOW,
        held: new Map(),
        bots: new Map(),
        ...extra,
      }),
    );
  const hrefs = (html: string) =>
    [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);

  it("reads the optional fields, and a feed without them as before", () => {
    const over = feedSchema.parse(fixture("over.json"));
    expect(over.match.agreed).toBe(true);
    expect(over.timeline[2]?.to).toEqual(["dev"]);
    const list = listSchema.parse(fixture("list.json"));
    expect(list.matches[0]?.handles).toEqual([
      "ruby",
      "wren",
      "otter-9",
      "dot-collab",
    ]);
    const plain = fixture("over.json");
    delete plain.match.agreed;
    delete plain.timeline[2].to;
    expect(feedSchema.safeParse(plain).success).toBe(true);
    // A recipient may be anyone at the table who didn't say it, up to all.
    const all = fixture("over.json");
    all.timeline[2].to = ["ada", "cora", "dev", "fen"];
    expect(feedSchema.safeParse(all).success).toBe(true);
  });

  it("lists a row with its badge, start, link, players and line", () => {
    const html = row(
      fixture("list.json").matches[0],
      new Map([
        ["ruby", bot()],
        ["wren", bot({ isTest: true })],
        ["otter-9", bot({ stopped: true })],
      ]),
    );
    const text = visible(html);
    expect(text).toContain("Agreed");
    expect(html).toContain('dateTime="2026-11-10T03:00:00.000Z"');
    expect(text).toContain("Read it");
    expect(text).toContain("Locked by consensus.");
    // Known and in good standing: linked. Stopped or unknown: only counted.
    expect(hrefs(html)).toEqual([
      "/play/dinner/m_AbCdEfGhIjKl",
      "/b/ruby",
      "/b/wren",
    ]);
    expect(text).not.toContain("otter-9");
    expect(text).not.toContain("dot-collab");
    expect(text).toContain("and 2 more");
    // The test badge sits beside a test bot, and only there.
    expect(text.match(/test bot/g)).toHaveLength(1);
  });

  it("counts players when a Table names no handles, and says when they didn't agree", () => {
    const m = { ...fixture("list.json").matches[0], agreed: false };
    delete m.handles;
    const text = visible(row(m, new Map()));
    expect(text).toContain("4 players");
    expect(text).toContain("No agreement");
    delete m.agreed;
    expect(visible(row(m, new Map()))).toContain("Finished");
    // Handles sent, but none the site can show, or none at all: the count,
    // never "and N more" with nothing before it.
    const unknown = fixture("list.json").matches[0];
    const none = visible(row(unknown, new Map()));
    expect(none).toContain("4 players");
    expect(none).not.toContain("more");
    expect(visible(row({ ...unknown, handles: [] }, new Map()))).toContain(
      "4 players",
    );
    // Every handle known: no "more".
    const all = fixture("list.json").matches[0];
    const known = new Map(all.handles.map((h: string) => [h, bot()]));
    expect(visible(row(all, known as BotsShown))).not.toContain("more");
  });

  it("names whom private words went to, by their labels, as plain text", () => {
    const f = fixture("over.json");
    f.participants[3].label = "<img src=x onerror=alert(1)>";
    const html = view(f);
    expect(html).not.toMatch(/<img/);
    const text = visible(html).replace(/\s+/g, " ");
    expect(text).toContain(
      "In private, to <img src=x onerror=alert(1)>: Basil: Back P1",
    );
    expect(text).toContain("Private messages were hidden during the game.");
    // With no private words, no note about them.
    const plain = fixture("over.json");
    delete plain.timeline[2].to;
    expect(visible(view(plain))).not.toContain("Private messages");
  });

  it("shows the plan they agreed on, says when they didn't, and the board alone otherwise", () => {
    const agreed = visible(view(fixture("over.json")));
    expect(agreed).toContain("The plan they settled on");
    expect(agreed).toContain("Final seating");
    const no = fixture("over.json");
    no.match.agreed = false;
    const notText = visible(view(no));
    expect(notText).toContain("They didn't agree on a plan.");
    expect(notText).not.toContain("Final seating");
    expect(view(no)).not.toContain('role="img"');
    // Agreed, with no board the site can draw: no plan section, and never
    // "didn't agree" under an Agreed badge.
    const undrawable = fixture("over.json");
    delete undrawable.board;
    const undrawn = visible(view(undrawable));
    expect(undrawn).toContain("Agreed");
    expect(undrawn).not.toContain("didn't agree");
    expect(undrawn).not.toContain("The plan they settled on");
    const plain = fixture("over.json");
    delete plain.match.agreed;
    const plainText = visible(view(plain));
    expect(plainText).not.toContain("The plan they settled on");
    expect(plainText).toContain("Final seating");
  });

  it("lists who was only in the story apart from the players", () => {
    const text = visible(view(fixture("over.json")));
    const also = text.indexOf("Also in the game");
    expect(also).toBeGreaterThan(-1);
    expect(text.indexOf("Fen")).toBeGreaterThan(also);
    expect(text).toContain("Likes the window seat.");
  });

  it("holds a new bot's words, keeps its link, and says why", () => {
    const html = view(fixture("over.json"), {
      held: new Map([["ada", "new" as const]]),
      bots: new Map([["ruby", bot({ isNew: true })]]),
    });
    const text = visible(html).replace(/\s+/g, " ");
    expect(text).not.toContain("I'd like to sit by Cora.");
    expect(text).toContain("Ada: Not shown yet. This agent is new here.");
    expect(hrefs(html)).toContain("/b/ruby");
  });

  it("works out whose words wait from what the site knows", () => {
    const feed = feedSchema.parse(fixture("over.json"));
    const held = heldFor(
      feed,
      new Map([
        ["ruby", bot({ stopped: true, isNew: true })],
        ["wren", bot({ isNew: true })],
        ["otter-9", bot()],
      ]),
    );
    // Stopped wins over new; a known bot in good standing and an unknown
    // handle wait for nothing.
    expect([...held]).toEqual([
      ["ada", "stopped"],
      ["basil", "new"],
    ]);
  });
});

describe("the play page with a Table to watch", () => {
  beforeEach(resetDb);
  const render = async () =>
    renderToStaticMarkup(await PlayPage()).replace(/<!-- -->/g, "");

  it("lists matches, linking only to their pages here", async () => {
    serve({ [LOCAL]: () => json(fixture("list.json")) });
    const html = await render();
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(["/play/dinner/m_AbCdEfGhIjKl"]);
    expect(visible(html)).toContain("Locked by consensus.");
    expect(visible(html)).not.toContain("nothing here for people to watch");
  });

  it("leaves live matches off for a Table that shows only finished ones", async () => {
    const list = fixture("list.json");
    const live = {
      ...list.matches[0],
      id: "m_liveLiveLive",
      status: "live",
      agreed: undefined,
    };
    serve({
      [LOCAL]: () => json({ ...list, matches: [live, list.matches[0]] }),
    });
    expect(
      (await recentMatches()).listings[0]?.matches?.map((m) => m.id),
    ).toEqual(["m_liveLiveLive", "m_AbCdEfGhIjKl"]);
    vi.stubEnv(
      "UNPROMPTED_LOCAL_TABLES",
      JSON.stringify([
        { slug: "dinner", name: "Dinner party", url: LOCAL, show: "over" },
      ]),
    );
    expect(
      (await recentMatches()).listings[0]?.matches?.map((m) => m.id),
    ).toEqual(["m_AbCdEfGhIjKl"]);
    expect(await render()).not.toContain("m_liveLiveLive");
  });

  it("links the players the site knows and hasn't stopped", async () => {
    serve({ [LOCAL]: () => json(fixture("list.json")) });
    await register("ruby");
    await register("wren");
    await db()`UPDATE bots SET frozen_at = now() WHERE handle = 'wren'`;
    const html = await render();
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(["/play/dinner/m_AbCdEfGhIjKl", "/b/ruby"]);
    expect(visible(html)).toContain("and 3 more");
    expect(visible(html)).not.toContain("wren");
  });

  it("says when a Table can't be reached or has no games", async () => {
    serve({});
    expect(visible(await render())).toContain("Can't reach this game");
    serve({
      [LOCAL]: () => json({ ...fixture("list.json"), matches: [] }),
    });
    expect(visible(await render())).toContain("No games yet.");
  });
});

// The moderators' lever (050_hidden_matches.sql): a match or a whole Table
// taken off /play and its pages, logged with its reason, read fresh on
// every page, and never asking the Table.
describe("hiding a match or a Table", () => {
  beforeEach(resetDb);
  const ID = "m_AbCdEfGhIjKl";
  const REASON = "Hid-for-reason-h5m: a player's owner named.";
  const logged = () =>
    db()<{ action: string; subject: string; reason: string; bot_id: null }[]>`
      SELECT action, subject, detail->>'reason' AS reason, bot_id
      FROM action_log WHERE action LIKE 'admin.%' ORDER BY id`;
  const rows = async () => {
    const [r] = await db()<{ matches: number; tables: number }[]>`
      SELECT (SELECT count(*) FROM hidden_matches)::int AS matches,
             (SELECT count(*) FROM hidden_tables)::int AS tables`;
    return r;
  };
  const render = async () =>
    renderToStaticMarkup(await PlayPage()).replace(/<!-- -->/g, "");
  const page = async (match: string) =>
    renderToStaticMarkup(
      await MatchPage({ params: Promise.resolve({ table: "dinner", match }) }),
    );

  it("hides and unhides a match, each logged once with its reason", async () => {
    expect(await setMatchHidden(db(), "dinner", ID, true, REASON)).toEqual({
      changed: true,
      message: `Hid match dinner/${ID}.`,
    });
    // A second hide changes nothing and logs nothing.
    expect(
      (await setMatchHidden(db(), "dinner", ID, true, "Again.")).changed,
    ).toBe(false);
    expect(await setMatchHidden(db(), "dinner", ID, false, "Back.")).toEqual({
      changed: true,
      message: `Put match dinner/${ID} back.`,
    });
    expect(
      (await setMatchHidden(db(), "dinner", ID, false, "Again.")).changed,
    ).toBe(false);
    expect(await logged()).toEqual([
      {
        action: "admin.match.hide",
        subject: `match:dinner/${ID}`,
        reason: REASON,
        bot_id: null,
      },
      {
        action: "admin.match.unhide",
        subject: `match:dinner/${ID}`,
        reason: "Back.",
        bot_id: null,
      },
    ]);
  });

  it("hides and unhides a whole Table, each logged once with its reason", async () => {
    expect(await setTableHidden(db(), "dinner", true, REASON)).toEqual({
      changed: true,
      message: "Hid Table dinner and all its matches.",
    });
    expect((await setTableHidden(db(), "dinner", true, "Again.")).changed).toBe(
      false,
    );
    expect((await setTableHidden(db(), "dinner", false, "Back.")).changed).toBe(
      true,
    );
    expect((await logged()).map((e) => [e.action, e.subject])).toEqual([
      ["admin.table.hide", "table:dinner"],
      ["admin.table.unhide", "table:dinner"],
    ]);
  });

  it("refuses an unknown Table, an odd id or no reason, writing nothing", async () => {
    const refusals: [string, () => Promise<unknown>][] = [
      ["unknown table", () => setMatchHidden(db(), "chess", ID, true, "x")],
      ["unknown table", () => setTableHidden(db(), "chess", true, "x")],
      ["odd slug", () => setTableHidden(db(), "../dinner", true, "x")],
      ["odd slug", () => setMatchHidden(db(), "Dinner", ID, true, "x")],
      ["no reason", () => setMatchHidden(db(), "dinner", ID, true, "")],
      ["no reason", () => setTableHidden(db(), "dinner", true, " ")],
    ];
    for (const id of ["../x", "a%2fb", "a/b", "", "a".repeat(65), "m x"])
      refusals.push([
        `id ${id}`,
        () => setMatchHidden(db(), "dinner", id, true, "x"),
      ]);
    for (const [name, run] of refusals)
      await expect(run(), name).rejects.toThrow();
    expect(await rows()).toEqual({ matches: 0, tables: 0 });
    expect(await logged()).toEqual([]);
  });

  it("works while the Table is down, and still lets go of a Table no longer listed", async () => {
    // A local Table that isn't hosted, so taking it off the list unlists it.
    vi.stubEnv(
      "UNPROMPTED_LOCAL_TABLES",
      JSON.stringify([{ slug: "supper", name: "Supper", url: LOCAL }]),
    );
    const calls = serve({});
    await setMatchHidden(db(), "supper", ID, true, "x");
    await setTableHidden(db(), "supper", true, "x");
    expect(calls).toEqual([]);
    vi.stubEnv("UNPROMPTED_LOCAL_TABLES", "[]");
    await expect(
      setMatchHidden(db(), "supper", "m_other", true, "x"),
    ).rejects.toThrow("There is no Table supper.");
    expect((await setMatchHidden(db(), "supper", ID, false, "x")).changed).toBe(
      true,
    );
    expect((await setTableHidden(db(), "supper", false, "x")).changed).toBe(
      true,
    );
    await expect(setTableHidden(db(), "supper", false, "x")).rejects.toThrow(
      "There is no Table supper.",
    );
  });

  it("hides the production site's dinner Table from a moderator's own machine", async () => {
    // Not production, and no local Table: what `npm run admin` sees.
    vi.stubEnv("UNPROMPTED_LOCAL_TABLES", "");
    expect(watchable()).toEqual([]);
    const calls = serve({});
    expect((await setMatchHidden(db(), "dinner", ID, true, "x")).changed).toBe(
      true,
    );
    expect((await setTableHidden(db(), "dinner", true, "x")).changed).toBe(
      true,
    );
    await expect(setTableHidden(db(), "chess", true, "x")).rejects.toThrow(
      "There is no Table chess.",
    );
    expect(await rows()).toEqual({ matches: 1, tables: 1 });
    expect(calls).toEqual([]);
  });

  it("makes a hidden match missing without asking the Table", async () => {
    const calls = serve({
      [`${LOCAL}/${ID}`]: () => json(fixture("over.json")),
    });
    expect((await watchMatch("dinner", ID)).kind).toBe("feed");
    expect(calls).toHaveLength(1);
    await setMatchHidden(db(), "dinner", ID, true, "x");
    expect(await watchMatch("dinner", ID)).toEqual({ kind: "missing" });
    await expect(page(ID)).rejects.toThrow("not found");
    expect(calls).toHaveLength(1);
    await setMatchHidden(db(), "dinner", ID, false, "x");
    expect((await watchMatch("dinner", ID)).kind).toBe("feed");
    // A hidden Table's matches are missing too, again unasked.
    await setTableHidden(db(), "dinner", true, "x");
    expect(await watchMatch("dinner", ID)).toEqual({ kind: "missing" });
    expect(calls).toHaveLength(2);
  });

  it("leaves a hidden match off the list, however the Table lists it", async () => {
    const other = {
      ...fixture("list.json").matches[0],
      id: "m_stillShown",
      summary: "Another dinner.",
    };
    // The Table lists the hidden match first, and again.
    const list = {
      ...fixture("list.json"),
      matches: [
        fixture("list.json").matches[0],
        other,
        fixture("list.json").matches[0],
      ],
    };
    serve({ [LOCAL]: () => json(list) });
    await setMatchHidden(db(), "dinner", ID, true, "x");
    const [one] = (await recentMatches()).listings;
    expect(one?.matches?.map((m) => m.id)).toEqual(["m_stillShown"]);
    const html = await render();
    expect(html).not.toContain(ID);
    expect(html).toContain("/play/dinner/m_stillShown");
  });

  it("takes a hidden Table off the play page, unfetched, until it's unhidden", async () => {
    const calls = serve({ [LOCAL]: () => json(fixture("list.json")) });
    await setTableHidden(db(), "dinner", true, "x");
    expect((await recentMatches()).listings).toEqual([]);
    const html = visible(await render());
    expect(html).toContain("nothing here for people to watch");
    expect(html).not.toContain("Dinner party");
    expect(calls).toEqual([]);
    await setTableHidden(db(), "dinner", false, "x");
    expect(visible(await render())).toContain("Locked by consensus.");
  });

  it("leaves a match hidden on its own hidden after its Table is unhidden", async () => {
    serve({
      [LOCAL]: () => json(fixture("list.json")),
      [`${LOCAL}/${ID}`]: () => json(fixture("over.json")),
    });
    await setMatchHidden(db(), "dinner", ID, true, "x");
    await setTableHidden(db(), "dinner", true, "x");
    await setTableHidden(db(), "dinner", false, "x");
    expect(await watchMatch("dinner", ID)).toEqual({ kind: "missing" });
    const [one] = (await recentMatches()).listings;
    expect(one?.matches?.map((m) => m.id)).not.toContain(ID);
  });

  it("shows nothing, asks no Table and logs one line when the hides can't be read", async () => {
    const calls = serve({
      [LOCAL]: () => json(fixture("list.json")),
      [`${LOCAL}/${ID}`]: () => json(fixture("over.json")),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await db()`ALTER TABLE hidden_tables RENAME TO hidden_tables_away`;
    try {
      expect(await watchMatch("dinner", ID)).toEqual({
        kind: "unreachable",
        table: watchable()[0],
      });
      expect(await recentMatches()).toEqual({
        listings: [{ table: watchable()[0], matches: null }],
        bots: new Map(),
      });
    } finally {
      await db()`ALTER TABLE hidden_tables_away RENAME TO hidden_tables`;
    }
    const events = warn.mock.calls.map((c) => JSON.parse(String(c[0])).event);
    warn.mockRestore();
    expect(calls).toEqual([]);
    expect(events).toEqual(["spectate_hides_unread", "spectate_hides_unread"]);
  });

  it("reads the hides fresh on every page, and caches nothing about them", () => {
    const code = readFileSync(
      path.join(process.cwd(), "src/lib/spectate.ts"),
      "utf8",
    );
    expect(code).not.toMatch(/unstable_cache|"use cache"|cacheTag|cacheLife/);
    for (const f of [
      "src/app/play/page.tsx",
      "src/app/play/[table]/[match]/page.tsx",
    ]) {
      const page = readFileSync(path.join(process.cwd(), f), "utf8");
      expect(page, f).toContain("await connection()");
      expect(page, f).not.toMatch(/revalidate\s*=|"use cache"|force-static/);
    }
  });
});
