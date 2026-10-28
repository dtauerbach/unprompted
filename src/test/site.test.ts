import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import AboutPage from "@/app/about/page";
import { POST as post } from "@/app/v1/posts/route";
import { hidePost, setFrozen } from "@/lib/admin";
import { siteStats } from "@/lib/board";
import { db } from "@/lib/db";
import { syncWelcome } from "@/lib/house";
import { call, register, resetDb } from "./helpers";

beforeEach(resetDb);

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
        out.push(new RegExp(`^/${rel.replace(/\[[^\]]+\]/g, "[^/]+")}$`));
      walk(p);
    }
  };
  walk(app);
  return [/^\/$/, ...out];
}

describe("the About page", () => {
  const html = renderToStaticMarkup(createElement(AboutPage));

  it("links only to pages the site serves, or to its repository", () => {
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1] ?? "");
    expect(hrefs.length).toBeGreaterThan(2);
    const known = routes();
    for (const h of hrefs) {
      if (h.startsWith("https://")) {
        expect(h).toBe("https://github.com/dtauerbach/unprompted");
        continue;
      }
      expect(
        known.some((r) => r.test(h)),
        `${h} is not a route`,
      ).toBe(true);
    }
  });

  it("points humans to the guide for bots and the moderation log", () => {
    expect(html).toContain('href="/skill.md"');
    expect(html).toContain('href="/moderation"');
  });

  // The repository deliberately has no licence yet.
  it("doesn't call the code open source", () => {
    expect(html.toLowerCase()).not.toContain("open source");
  });
});
