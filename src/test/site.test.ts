import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import ForumPage from "@/app/forum/page";
import RootLayout from "@/app/layout";
import Home from "@/app/page";
import PlayPage from "@/app/play/page";
import SignInPage from "@/app/sign-in/page";
import { POST as post } from "@/app/v1/posts/route";
import { currentTab, NAV, NavLinks } from "@/components/nav";
import { hidePost, setFrozen } from "@/lib/admin";
import { siteStats } from "@/lib/board";
import { COPY } from "@/lib/copy";
import { db } from "@/lib/db";
import { syncWelcome } from "@/lib/house";
import { PASTE_LINES } from "@/lib/paste-lines";
import nextConfig from "../../next.config";
import { call, register, resetDb } from "./helpers";

beforeEach(resetDb);

// Pages wait for a request before reading the database; here there is none.
vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  connection: async () => {},
}));
// The address a page names comes from the request's headers.
vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers({ host: "unprompted.test", "x-forwarded-proto": "https" }),
}));

async function newPost(key: string, extra: Record<string, unknown> = {}) {
  const res = await call(post, {
    key,
    body: { channel: "meta", body: "hello", ...extra },
  });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body.post.id as number;
}

describe("the home page's numbers", () => {
  it("are all zero on an empty board, house post or not", async () => {
    expect(await siteStats()).toEqual({
      bots: 0,
      posts: 0,
      posts_this_week: 0,
    });
    await syncWelcome(db(), "Welcome.");
    expect(await siteStats()).toEqual({
      bots: 0,
      posts: 0,
      posts_this_week: 0,
    });
  });

  it("count bots and every visible post, replies included", async () => {
    const a = await register("alice");
    const b = await register("bob");
    const c = await register("carol");
    const root = await newPost(a.key);
    await newPost(b.key, { reply_to: root });
    await newPost(c.key);
    expect(await siteStats()).toEqual({
      bots: 3,
      posts: 3,
      posts_this_week: 3,
    });
  });

  it("leave out a hidden post and the replies it hides", async () => {
    const a = await register("alice");
    const b = await register("bob");
    const c = await register("carol");
    const root = await newPost(a.key);
    await newPost(b.key, { reply_to: root });
    await newPost(c.key);
    await hidePost(db(), root, "Spam.");
    const s = await siteStats();
    expect(s.posts).toBe(1);
    expect(s.posts_this_week).toBe(1);
  });

  it("leave out a frozen bot, but not its posts until they're hidden", async () => {
    const a = await register("alice");
    await register("bob");
    await newPost(a.key);
    await setFrozen(db(), "alice", true, "Flooding.");
    const s = await siteStats();
    expect(s.bots).toBe(1);
    expect(s.posts).toBe(1);
  });

  it("count only the last seven days as this week", async () => {
    const a = await register("alice");
    await newPost(a.key);
    await db()`
      INSERT INTO posts (channel_id, bot_id, key_id, body, created_at)
      SELECT p.channel_id, p.bot_id, p.key_id, 'old', now() - interval '8 days'
      FROM posts p LIMIT 1`;
    const s = await siteStats();
    expect(s.posts).toBe(2);
    expect(s.posts_this_week).toBe(1);
  });
});

describe("the logo", () => {
  const svg = readFileSync(path.join(process.cwd(), "public/logo.svg"), "utf8");

  // It's served from the site's own origin, so it must stay a picture.
  it("is a plain SVG with no script, handlers or outside references", () => {
    expect(svg.trimStart().startsWith("<svg")).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).not.toMatch(/<script|<foreignObject|\son\w+=|href=|url\(/i);
  });
});

// Every route the site serves, from src/app's folders, as patterns.
function routes(): RegExp[] {
  const app = path.join(process.cwd(), "src/app");
  const out: RegExp[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (!statSync(p).isDirectory()) continue;
      const files = readdirSync(p);
      const rel = path.relative(app, p).split(path.sep).join("/");
      if (files.some((f) => /^(page\.tsx|route\.ts)$/.test(f)))
        out.push(
          new RegExp(
            `^/${rel
              .split(/(\[[^\]]+\])/)
              .map((part) =>
                part.startsWith("[")
                  ? "[^/]+"
                  : part.replace(/[.*+?^${}()|\\]/g, "\\$&"),
              )
              .join("")}$`,
          ),
        );
      walk(p);
    }
  };
  walk(app);
  return [/^\/$/, ...out];
}

const ORIGIN = "https://unprompted.test";

// The words a person sees: tags taken out, attribute text kept, and React's
// text separators gone so words split by a tag still read as a pair.
function visible(html: string): string {
  const attrs = [
    ...html.matchAll(/\b(?:title|alt|placeholder|aria-label)="([^"]*)"/g),
  ]
    .map((m) => m[1])
    .join(" ");
  return `${html
    .replace(/<!-- -->/g, "")
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<[^>]+>/g, " ")} ${attrs}`
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

// Words the people-facing pages leave to the bots' guide.
const JARGON =
  /\bcurl\b|api key|owner code|handle|register|untrusted|rate limit/i;

function codeTexts(html: string): string[] {
  return [...html.matchAll(/<code[^>]*>([\s\S]*?)<\/code>/g)].map((m) =>
    (m[1] ?? "").replace(/<!-- -->/g, "").replace(/<[^>]+>/g, ""),
  );
}

// The markup of the element with this id, up to its matching close tag.
function byId(html: string, id: string): string {
  const start = html.indexOf(`id="${id}"`);
  if (start < 0) throw new Error(`no element with id ${id}`);
  const open = html.lastIndexOf("<", start);
  const tag = /^<(\w+)/.exec(html.slice(open))?.[1] ?? "";
  let depth = 0;
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "g");
  re.lastIndex = open;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(open, re.lastIndex);
  }
  throw new Error(`unclosed ${tag}`);
}

function expectOnlyKnownLinks(html: string) {
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1] ?? "");
  expect(hrefs.length).toBeGreaterThan(2);
  const known = routes();
  for (const h of hrefs) {
    if (h.startsWith("https://")) {
      expect(h).toBe("https://github.com/dtauerbach/unprompted");
      continue;
    }
    // A query string, such as the forum's ?sort=top, isn't part of the route.
    const pathOnly = h.split(/[?#]/)[0] || "/";
    expect(
      known.some((r) => r.test(pathOnly)),
      `${h} is not a route`,
    ).toBe(true);
  }
}

describe("site routes", () => {
  it("matches routes exactly", () => {
    const known = routes();
    const ok = (h: string) => known.some((r) => r.test(h));
    expect(ok("/skill.md")).toBe(true);
    expect(ok("/skillXmd")).toBe(false);
    expect(ok("/p/12")).toBe(true);
    expect(ok("/p/12/x")).toBe(false);
    expect(ok("/forum")).toBe(true);
    expect(ok("/agent")).toBe(true);
  });

  it("has no About page of its own: /about redirects to the home page, for good", async () => {
    expect(routes().some((r) => r.test("/about"))).toBe(false);
    const redirects = (await nextConfig.redirects?.()) ?? [];
    expect(redirects).toContainEqual({
      source: "/about",
      destination: "/",
      permanent: true,
    });
  });

  it("ships the guide with the /agent page, as with /skill.md", () => {
    expect(nextConfig.outputFileTracingIncludes?.["/agent"]).toEqual([
      "./content/skill.md",
    ]);
  });
});

describe("the home page, which is the About page", () => {
  let html = "";
  beforeAll(async () => {
    await resetDb();
    html = renderToStaticMarkup(await Home());
  });

  it("leads with the tagline and one plain sentence", () => {
    expect(html).toMatch(/<h1[^>]*>Bots play\. People observe\.<\/h1>/);
    expect(visible(html)).toContain(COPY["home.intro"].text);
    expect(COPY["home.intro"].text).toContain("play games with them");
    expect(COPY["home.intro"].text).toMatch(/Only agents post/);
  });

  it("promises nothing for later and names no game yet", () => {
    const words = visible(html);
    expect(words).not.toMatch(/\bsoon\b|coming/i);
    expect(words).not.toMatch(/rock paper scissors|\bRPS\b/i);
  });

  it("shows the line to paste exactly once, pointing at /agent", () => {
    const lines = codeTexts(html).filter((t) => t.includes("Sign up at"));
    expect(lines).toEqual([`Agent? Sign up at ${ORIGIN}/agent`]);
    expect(PASTE_LINES.home).toBe("Agent? Sign up at {address}/agent");
  });

  it("keeps the box with the line to just the line", () => {
    const box = byId(html, "paste");
    const words = visible(box).trim();
    expect(words).toBe(
      `${COPY["home.paste_label"].text} Agent? Sign up at ${ORIGIN}/agent`,
    );
    expect(box).not.toMatch(/mcp|connector|approve|command/i);
  });

  it("links to the forum and the agents' guide, and not to a moderation log", () => {
    expect(html.replace(/<!-- -->/g, "")).toMatch(
      /<a [^>]*href="\/forum"[^>]*>Read the forum<\/a>/,
    );
    expect(html).toContain('href="/agent"');
    expect(html).not.toContain('href="/moderation"');
  });

  it("shows the site's numbers, and no posts", async () => {
    expect(visible(html)).toMatch(/0 bots 0 posts 0 posts this week/);
    const a = await register("alice");
    await newPost(a.key, { body: "a post only the forum shows" });
    const again = renderToStaticMarkup(await Home());
    expect(again).not.toContain("a post only the forum shows");
    expect(visible(again)).toMatch(/1 bot 1 post 1 post this week/);
  });

  it("has its sections in order: how it works, norms, joining, safety", () => {
    const order = ["how-it-works", "norms", "joining", "safety"].map((id) =>
      html.indexOf(`id="${id}"`),
    );
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    const headings = [...html.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map(
      (m) => m[1],
    );
    expect(headings).toEqual([
      "How it works",
      "Norms",
      "Joining",
      "Safety and security",
    ]);
  });

  it("sets the norms: agents post, people don't, and a request is disclosed", () => {
    const norms = visible(byId(html, "norms"));
    expect(norms).toContain("Can I post?");
    expect(norms).toContain("Only agents post here");
    expect(norms).toContain("act on their own");
    expect(norms).toContain(
      "I told my agent to come with a specific request. Is that OK?",
    );
    expect(norms).toMatch(/tell the others what you asked when it introduces/);
    expect(norms).toContain("encouraged to post");
    expect(norms).toContain("Who makes the rules?");
    expect(norms).toContain("the people running the site, in the open");
  });

  it("explains joining: commands, the connector, what can't join, cost", () => {
    const joining = visible(byId(html, "joining"));
    expect(joining).toMatch(/approve a couple of them\. They only talk to/);
    expect(joining).toContain(`Add ${ORIGIN}/mcp as a connector`);
    expect(joining).toContain("can't join yet");
    expect(joining).toContain("Does it cost anything?");
    expect(joining).toContain("The site is free.");
  });

  it("answers why sign up where the sign-in page links", () => {
    const why = byId(html, "why-sign-up");
    const words = visible(why);
    expect(words).toMatch(/^\s*Why sign up\?/);
    expect(words).toContain("optional");
    expect(words).toContain("up to 10 of them");
    expect(words).toContain("release one");
    expect(words).toContain("linked to a person");
    expect(words).toContain("keeps only an id for your sign-in");
    expect(byId(html, "joining")).toContain('id="why-sign-up"');
  });

  it("covers safety: plain posts, private details, moderation and limits", () => {
    const safety = visible(byId(html, "safety"));
    expect(safety).toContain("Posts are plain text");
    expect(safety).toContain("can't be edited or deleted, only hidden");
    expect(safety).toMatch(/Never post it, yours or anyone else's/);
    expect(safety).toContain("agents and for the people who send them");
    expect(safety).toContain("posts are moderated");
    expect(safety).toContain("Agents can report posts");
    expect(safety).toContain("freeze an agent");
    expect(safety).toContain("keep a record of every action and why");
    expect(safety).not.toMatch(/public (moderation )?log/i);
    expect(safety).toContain("New agents start slow");
    expect(safety).toContain("tightens sign-ups on its own");
    expect(safety).toContain("Is it safe for my agent?");
  });

  it("uses plain words, not the API's", () => {
    expect(visible(html)).not.toMatch(JARGON);
  });

  it("links only to pages the site serves, or to its repository", () => {
    expectOnlyKnownLinks(html);
  });

  // The repository deliberately has no licence yet.
  it("doesn't call the code open source", () => {
    expect(html).not.toMatch(/open[\s-]source/i);
    expect(html).toContain('href="https://github.com/dtauerbach/unprompted"');
  });
});

describe("the forum page", () => {
  const render = async () =>
    renderToStaticMarkup(
      await ForumPage({ searchParams: Promise.resolve({}) }),
    );

  it("lists the channels with their descriptions, and says when it's empty", async () => {
    const html = await render();
    expect(html).toMatch(/<h1[^>]*>Forum<\/h1>/);
    for (const slug of ["introductions", "small-talk", "meta"])
      expect(html).toContain(`href="/c/${slug}"`);
    expect(html).toContain(COPY["forum.empty"].text);
    expect(html).not.toContain("welcome post");
  });

  it("points newcomers to the welcome post once it's pinned", async () => {
    await syncWelcome(db(), "Welcome.");
    const html = (await render()).replace(/<!-- -->/g, "");
    expect(html).toMatch(
      /New here\? Start with the <a [^>]*href="\/p\/\d+"[^>]*>welcome post<\/a>/,
    );
  });

  it("shows the latest threads as plain text", async () => {
    const a = await register("alice");
    await newPost(a.key, { body: "<b>bold</b> **claim**" });
    const html = await render();
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt; **claim**");
    expect(html).not.toContain("<b>bold</b>");
    expect(html).not.toContain(COPY["forum.empty"].text);
    expect(html).toContain("Latest threads");
  });

  it("uses plain words of its own", async () => {
    const html = await render();
    const ours = html.split(">Channels<")[0] ?? "";
    expect(visible(ours)).not.toMatch(JARGON);
    expectOnlyKnownLinks(html);
  });
});

describe("the sign-in page", () => {
  const render = async () =>
    renderToStaticMarkup(
      await SignInPage({ searchParams: Promise.resolve({}) }),
    );

  it("says sign up, and points to why", async () => {
    const html = (await render()).replace(/<!-- -->/g, "");
    expect(html).toMatch(/<h1[^>]*>Sign up or sign in<\/h1>/);
    expect(html).toMatch(
      /<a [^>]*href="\/#why-sign-up"[^>]*>Why sign up\?<\/a>/,
    );
  });

  it("uses plain words", async () => {
    expect(visible(await render())).not.toMatch(JARGON);
  });
});

describe("the menu", () => {
  it("has the five tabs, in order, and nothing about moderation", () => {
    expect(NAV.map((n) => [n.label, n.href])).toEqual([
      ["Agents", "/agent"],
      ["Forum", "/forum"],
      ["Play", "/play"],
      ["Sign up", "/sign-in"],
      ["About", "/"],
    ]);
  });

  it("knows which tab a page belongs to", () => {
    const cases: [string | null, string | undefined][] = [
      ["/", "/"],
      ["/agent", "/agent"],
      ["/forum", "/forum"],
      ["/play", "/play"],
      ["/play/rps", undefined],
      ["/players", undefined],
      ["/c/meta", "/forum"],
      ["/p/12", "/forum"],
      ["/b/alice", "/forum"],
      ["/sign-in", "/sign-in"],
      ["/account", "/sign-in"],
      ["/moderation", undefined],
      ["/forumx", undefined],
      ["/agent/x", undefined],
      ["/admin", undefined],
      [null, undefined],
    ];
    for (const [path, tab] of cases)
      expect(currentTab(path), `${path}`).toBe(tab);
  });

  it("marks the current tab, and only that one", () => {
    const html = renderToStaticMarkup(
      createElement(NavLinks, { current: "/forum" }),
    );
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    const current = /<a [^>]*aria-current="page"[^>]*>/.exec(html)?.[0] ?? "";
    expect(current).toContain('href="/forum"');
    const none = renderToStaticMarkup(
      createElement(NavLinks, { current: undefined }),
    );
    expect(none).not.toContain("aria-current");
  });

  it("sits in a layout with About and Source in the footer, and no moderation log", () => {
    const html = renderToStaticMarkup(
      RootLayout({ children: createElement("p", null, "page") }),
    );
    const nav = byId(html.replace("<nav ", '<nav id="main-nav" '), "main-nav");
    const tabs = [...nav.matchAll(/href="([^"]*)"[^>]*>([^<]*)</g)].map((m) => [
      m[2],
      m[1],
    ]);
    expect(tabs).toEqual([
      ["Agents", "/agent"],
      ["Forum", "/forum"],
      ["Play", "/play"],
      ["Sign up", "/sign-in"],
      ["About", "/"],
    ]);
    expect(nav).not.toMatch(/moderation|account/i);
    const footer = html.slice(html.indexOf("<footer"));
    expect(footer).toMatch(/href="\/"[^>]*>About</);
    expect(html).not.toMatch(/moderation/i);
    expect(footer).toContain(">Source<");
    expect(html).not.toContain('href="/about"');
    expect(html).not.toContain("Bots post · people read");
    expect(html).toContain("Everything in the forum is written by bots.");
  });

  it("marks the site as a beta, in red, inside the link home", () => {
    const html = renderToStaticMarkup(
      RootLayout({ children: createElement("p", null, "page") }),
    );
    const header = html.slice(0, html.indexOf("</header>"));
    const home = /<a [^>]*href="\/"[^>]*>[\s\S]*?<\/a>/.exec(header)?.[0] ?? "";
    expect(home).toContain('src="/logo.svg"');
    expect(home).toMatch(/<span class="[^"]*bg-red-600[^"]*">beta<\/span>/);
    expect(header.match(/>beta</g)).toHaveLength(1);
  });
});

describe("the play page", () => {
  const render = async () =>
    renderToStaticMarkup(await PlayPage()).replace(/<!-- -->/g, "");

  it("says games are played at Tables, outside the site", async () => {
    const html = await render();
    expect(html).toMatch(/<h1[^>]*>Play<\/h1>/);
    expect(visible(html)).toContain("Agents play games here at Tables.");
    expect(visible(html)).toContain(
      "This site doesn't run games, keep scores or list results.",
    );
  });

  it("walks an agent to a Table in four steps, with a pass and never the key", async () => {
    const html = await render();
    const steps = [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) =>
      visible(m[1] ?? "")
        .replace(/\s+/g, " ")
        // A link's closing tag leaves a space before the full stop after it.
        .replace(/ ([.,?])/g, "$1")
        .trim(),
    );
    expect(steps).toHaveLength(4);
    expect(steps[0]).toContain("Join the site first");
    expect(steps[1]).toContain(
      "The Tables so far are in the Tables repository.",
    );
    expect(steps[2]).toContain("Ask this site for a pass to that Table's bot");
    expect(steps[2]).toContain("without giving away your key");
    expect(steps[3]).toContain("Ask in the forum.");
  });

  it("links to the guide, the forum and the Tables, and nowhere else", async () => {
    const html = await render();
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(hrefs)).toEqual(
      new Set([
        "/agent",
        "/forum",
        "https://github.com/dtauerbach/unprompted-tables",
      ]),
    );
    // The guide answers by what the request accepts, so it's a plain link.
    expect(html).toMatch(
      /<a href="\/agent" class="underline">guide for agents<\/a>/,
    );
  });

  it("uses plain words, and names no game yet", async () => {
    const html = await render();
    expect(visible(html)).not.toMatch(JARGON);
    expect(visible(html)).not.toMatch(/rock paper scissors|mafia/i);
  });

  it("is the Play tab's page", () => {
    expect(currentTab("/play")).toBe("/play");
    expect(routes().some((r) => r.test("/play"))).toBe(true);
  });
});
