import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MatchPage, { generateMetadata } from "@/app/play/[table]/[match]/page";
import PlayPage from "@/app/play/page";
import { currentTab } from "@/components/nav";
import { MatchView, shown } from "@/components/spectator";
import { COPY, type Copy } from "@/lib/copy";
import { MAX_FEED_BYTES, recentMatches, watchMatch } from "@/lib/spectate";
import {
  boardOf,
  feedSchema,
  hiddenCharacter,
  LIMITS,
  listSchema,
  visibleText,
} from "@/lib/spectator";
import { TABLES, watchable } from "@/lib/tables";
import { resetDb } from "./helpers";

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

  const bad = fixture("bad.json") as Record<
    string,
    { path: (string | number)[]; value: unknown }
  >;
  for (const [name, { path: keys, value }] of Object.entries(bad))
    it(`refuses a feed with ${name}`, () => {
      const v = value === "LONG" ? "x".repeat(LIMITS.text + 1) : value;
      expect(
        feedSchema.safeParse(setPath(fixture("live.json"), keys, v)).success,
      ).toBe(false);
    });

  it("finds hidden characters and strips them for a Table", () => {
    expect(hiddenCharacter("plain words")).toBe(false);
    for (const c of ["‮", "​", "⁦", "﻿", "\u0007"])
      expect(hiddenCharacter(`a${c}b`), c).toBe(true);
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
  });
});

describe("which Tables people can watch", () => {
  it("has no hosted feed yet, so only a local Table shows", () => {
    expect(TABLES.some((x) => x.spectate)).toBe(false);
    expect(watchable()).toEqual([
      { slug: "dinner", name: "Dinner party", url: LOCAL },
    ]);
  });

  it("ignores the local list on Vercel", () => {
    vi.stubEnv("VERCEL", "1");
    expect(watchable()).toEqual([]);
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
    const [one] = await recentMatches();
    expect(one?.matches).toHaveLength(1);
    serve({ [LOCAL]: () => json({ format: "something else" }) });
    expect((await recentMatches())[0]?.matches).toBeNull();
    serve({});
    expect((await recentMatches())[0]?.matches).toBeNull();
    serve({ [LOCAL]: () => new Response("<html>", { status: 200 }) });
    expect((await recentMatches())[0]?.matches).toBeNull();
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
    const huge = new ReadableStream({
      start(c) {
        const chunk = new Uint8Array(256 * 1024).fill(32);
        for (let n = 0; n * chunk.byteLength <= MAX_FEED_BYTES; n++)
          c.enqueue(chunk);
        c.close();
      },
    });
    serve({ [`${LOCAL}/m_big`]: () => new Response(huge) });
    expect((await watchMatch("dinner", "m_big")).kind).toBe("unreachable");
  });
});

describe("a match's page", () => {
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
      createElement(MatchView, { feed: evil(), table: "Dinner party", t }),
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
      createElement(MatchView, { feed, table: "Dinner party", t }),
    );
    const text = visible(html);
    expect(html).toContain('role="img"');
    expect(html).toMatch(/aria-label="Table: Ada, Basil, Cora, Dev"/);
    expect(text).toContain("Sent by Dinner party.");
    expect(text).toContain("Live");
    expect(text).toContain("left early");
    expect(text).not.toContain("How it ended");
  });

  it("shows the outcome and what was secret once a match is over", () => {
    const feed = feedSchema.parse(fixture("over.json"));
    const text = visible(
      renderToStaticMarkup(
        createElement(MatchView, { feed, table: "Dinner party", t }),
      ),
    );
    expect(text).toContain("How it ended");
    expect(text).toContain("Value captured");
    expect(text).toContain("80%");
    expect(text).toContain("Cora's brief");
    expect(text).toContain("Finished");
    expect(text).not.toContain("updates itself");
  });

  it("names the tab after tables.ts, never after the feed", async () => {
    expect(
      await generateMetadata({ params: Promise.resolve({ table: "dinner" }) }),
    ).toEqual({ title: "Dinner party" });
    expect(
      await generateMetadata({ params: Promise.resolve({ table: "chess" }) }),
    ).toEqual({});
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

  it("says when a Table can't be reached or has no games", async () => {
    serve({});
    expect(visible(await render())).toContain("Can't reach this game");
    serve({
      [LOCAL]: () => json({ ...fixture("list.json"), matches: [] }),
    });
    expect(visible(await render())).toContain("No games yet.");
  });
});
