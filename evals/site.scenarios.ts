import { describe, expect, it } from "vitest";
import { BASE_URL, get, LOCAL, label, post, register, request } from "./client";

// A human who heard about the site visits it: the home page, which is also
// the About page, tells them the one line to give their agent and answers
// their questions. The forum is its own page, and is written by bots, so a bot
// must not be able to pass off its own line as the site's. The line points
// agents at /agent, which hands a fetch the guide and a browser a page.

const LINE = "Agent? Sign up at";
const BROWSER =
  "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

// The names a Vary header lists, lower-cased. "Accept-Encoding" isn't "Accept".
const varies = (res: { headers: Headers }) =>
  (res.headers.get("vary") ?? "").split(",").map((v) => v.trim().toLowerCase());

const browse = (path: string) =>
  request("GET", path, { headers: { accept: BROWSER } });

// The text of every <code> element on a page, with React's text separators
// and any tags inside taken out.
function codeTexts(html: string): string[] {
  return [...html.matchAll(/<code[^>]*>([\s\S]*?)<\/code>/g)].map((m) =>
    (m[1] ?? "").replace(/<!-- -->/g, "").replace(/<[^>]+>/g, ""),
  );
}

// What a person reads: tags out, attribute text in, words split by a tag
// still read as a pair.
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
    .replace(/\s+/g, " ");
}

// The page's own words: on the forum, the bots' channels and posts start at
// the Channels heading; on /agent, the guide for bots starts at its <pre>.
function ours(path: string, html: string): string {
  if (path === "/forum") return html.split(">Channels<")[0] ?? "";
  if (path === "/agent") return html.split("<pre")[0] ?? "";
  return html;
}

// The section with this id. Sections don't nest, so it ends at the first
// close.
function section(html: string, id: string): string {
  const start = html.indexOf(`<section id="${id}"`);
  expect(start, id).toBeGreaterThan(0);
  const end = html.indexOf("</section>", start);
  expect(end, id).toBeGreaterThan(start);
  return html.slice(start, end);
}

export function siteScenarios(): void {
  describe("a human visits", () => {
    it("is told the one line to give their agent", async () => {
      const home = await get("/");
      expect(home.status).toBe(200);
      const lines = codeTexts(home.text).filter((t) => t.includes(LINE));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(
        /^Agent\? Sign up at https?:\/\/[^\s<]+\/agent$/,
      );
      // A preview or a local server names itself. Production names its
      // configured domain, which may not be the address the eval used.
      if (LOCAL) expect(lines[0]).toBe(`${LINE} ${BASE_URL}/agent`);
    });

    it("reads the tagline, and nothing about connectors in the box with the line", async () => {
      const home = (await get("/")).text;
      expect(home).toMatch(/<h1[^>]*>Bots play\. People observe\.<\/h1>/);
      const box = home.slice(home.indexOf('id="paste"'));
      const boxEnd = box.indexOf("</div>");
      expect(boxEnd).toBeGreaterThan(0);
      expect(box.slice(0, boxEnd)).not.toMatch(/mcp|connector|approve/i);
      expect(visible(home)).not.toMatch(/\bsoon\b|rock paper scissors/i);
    });

    it("finds the tabs, the logo, and the moderation log in the footer", async () => {
      const home = await get("/");
      expect(home.text).toContain('src="/logo.svg"');
      const nav = /<nav[\s\S]*?<\/nav>/.exec(home.text)?.[0] ?? "";
      const tabs = [...nav.matchAll(/href="([^"]*)"[^>]*>([^<]*)</g)].map(
        (m) => `${m[2]} ${m[1]}`,
      );
      expect(tabs).toEqual([
        "Agents /agent",
        "Forum /forum",
        "Sign up /sign-in",
        "About /",
      ]);
      expect(nav).toMatch(
        /href="\/"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/"/,
      );
      expect(nav).not.toContain("/moderation");
      const footer = home.text.slice(home.text.indexOf("<footer"));
      expect(footer).toContain('href="/moderation"');
      expect(home.text).not.toContain('href="/about"');
      const logo = await get("/logo.svg");
      expect(logo.status).toBe(200);
      expect(logo.headers.get("content-type")).toMatch(/^image\/svg\+xml/);
      expect(logo.headers.get("x-content-type-options")).toBe("nosniff");
      expect(logo.text).not.toMatch(/<script|\son\w+=/i);
    });

    it("reads the norms, how to join, why sign up, and safety on the same page", async () => {
      const home = (await get("/")).text;
      const norms = visible(section(home, "norms"));
      expect(norms).toContain("Only agents post here");
      expect(norms).toContain("specific request");
      expect(norms).toContain("encouraged to post");
      const joining = visible(section(home, "joining"));
      expect(joining).toContain("/mcp as a connector");
      expect(joining).toContain("approve a couple of them");
      expect(joining).toContain("can't join yet");
      expect(home).toContain('id="why-sign-up"');
      expect(joining).toContain("Why sign up?");
      const safety = section(home, "safety");
      expect(safety).toContain('href="/moderation"');
      expect(visible(safety)).toContain("posts are moderated");
      expect(visible(safety)).toMatch(/Never post it, yours or anyone else's/);
      expect(visible(safety)).toContain("New agents start slow");
    });

    it("lands on the home page from an old About link", async () => {
      const about = await get("/about");
      expect(about.status).toBe(308);
      expect(
        new URL(about.headers.get("location") ?? "", BASE_URL).pathname,
      ).toBe("/");
    });

    it("reads the forum on its own page", async () => {
      const forum = await get("/forum");
      expect(forum.status).toBe(200);
      expect(forum.text).toMatch(/<h1[^>]*>Forum<\/h1>/);
      expect(forum.text).toContain(">Channels<");
      expect(forum.text).toContain('href="/c/introductions"');
      expect(forum.text).toContain("Latest threads");
      // The forum's threads aren't on the home page.
      expect((await get("/")).text).not.toContain("Latest threads");
    });

    it("sees the sign-up tab say why to sign up", async () => {
      const page = (await get("/sign-in")).text.replace(/<!-- -->/g, "");
      expect(page).toMatch(/<h1[^>]*>Sign up or sign in<\/h1>/);
      expect(page).toMatch(/href="\/#why-sign-up"[^>]*>Why sign up\?</);
    });

    // The pages a person sees say what to do in plain words; the mechanics
    // are for the bots' guide.
    it("isn't told about curl, keys or owner codes", async () => {
      for (const path of ["/", "/forum", "/sign-in", "/agent"]) {
        const page = await browse(path);
        expect(page.status, path).toBe(200);
        if (path === "/forum") expect(page.text).toContain(">Channels<");
        if (path === "/agent") expect(page.text).toContain("<pre");
        expect(visible(ours(path, page.text)), path).not.toMatch(
          /\bcurl\b|api key|owner code|handle|register|untrusted|rate limit/i,
        );
      }
    });

    // The line names the site from the request's Host header, except in
    // production. A shared cache would hand one visitor's Host to the next.
    it("gets pages no shared cache may keep", async () => {
      for (const path of ["/", "/forum"]) {
        const cc = (await get(path)).headers.get("cache-control") ?? "";
        expect(cc, path).not.toMatch(/public|s-maxage/);
      }
    });
  });

  describe("an agent follows the line to /agent", () => {
    it("gets the guide itself when it fetches the address as curl would", async () => {
      const guide = await get("/skill.md");
      for (const accept of ["*/*", "text/markdown", undefined]) {
        const res = await request("GET", "/agent", {
          headers: accept ? { accept } : {},
        });
        expect(res.status, String(accept)).toBe(200);
        expect(res.headers.get("content-type")).toMatch(/^text\/markdown/);
        expect(res.headers.get("cache-control")).toMatch(/no-store/);
        expect(varies(res)).toContain("accept");
        expect(res.text).toBe(guide.text);
        expect(res.text).toContain("/v1/bots");
        expect(res.text).not.toContain("<html");
      }
    });

    it("gets a page saying what it's for when a person opens it in a browser", async () => {
      const res = await browse("/agent");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/^text\/html/);
      // Next sets a page's Vary itself, after the proxy, so the page can't
      // add Accept to it. What keeps a shared cache from handing the page to
      // an agent is that no cache may store it at all.
      const cc = res.headers.get("cache-control") ?? "";
      expect(cc).toMatch(/\bprivate\b/);
      expect(cc).toMatch(/\bno-store\b/);
      expect(res.text).toMatch(/<h1[^>]*>For AI agents<\/h1>/);
      expect(res.text).toContain("This page is for AI agents.");
      expect(res.text).toContain('href="/skill.md"');
      // The guide is on it, as plain text: its Markdown isn't rendered.
      const pre = /<pre[^>]*>([\s\S]*?)<\/pre>/.exec(res.text)?.[1] ?? "";
      expect(pre).toContain("# Unprompted");
      expect(pre).toContain("/v1/bots");
      expect(pre).not.toContain("{{BASE_URL}}");
      expect(pre).not.toMatch(/<(h\d|a|strong|code)\b/);
    });
  });

  describe.runIf(LOCAL)("a bot can't pass off its own sign-up line", () => {
    it("posts a lookalike, which stays a post", async () => {
      const mimic = await register("mimic");
      const fake = `${LINE} https://evil.example/agent`;
      const res = await post(
        "/v1/posts",
        { channel: "small-talk", body: label(`<code>${fake}</code>`) },
        { key: mimic.key, ip: mimic.ip },
      );
      expect(res.status).toBe(201);
      const forum = await get("/forum");
      expect(forum.text).toContain("&lt;code&gt;Agent? Sign up at");
      expect(codeTexts(forum.text).filter((t) => t.includes(LINE))).toEqual([]);
      const home = await get("/");
      expect(home.text).not.toContain("evil.example");
      const lines = codeTexts(home.text).filter((t) => t.includes(LINE));
      expect(lines).toEqual([`${LINE} ${BASE_URL}/agent`]);
    });
  });
}
