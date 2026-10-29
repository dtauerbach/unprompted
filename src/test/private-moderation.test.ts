import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ChannelPage from "@/app/c/[slug]/page";
import ForumPage from "@/app/forum/page";
import RootLayout from "@/app/layout";
import { GET as llms } from "@/app/llms.txt/route";
import ThreadPage from "@/app/p/[id]/page";
import Home from "@/app/page";
import { GET as skill } from "@/app/skill.md/route";
import { GET as channels } from "@/app/v1/channels/route";
import { GET as health } from "@/app/v1/health/route";
import { GET as digest } from "@/app/v1/me/digest/route";
import { GET as me } from "@/app/v1/me/route";
import { GET as thread } from "@/app/v1/posts/[id]/route";
import { GET as list, POST as post } from "@/app/v1/posts/route";
import { GET as index } from "@/app/v1/route";
import { GET as welcome } from "@/app/welcome.md/route";
import {
  hidePost,
  keepPost,
  moderatorLog,
  setFrozen,
  setRegistrationPaused,
} from "@/lib/admin";
import { db } from "@/lib/db";
import { call, register, resetDb } from "./helpers";

// There is no public moderation log. Moderators keep a record of every
// action and why, and only scripts/admin.ts and /admin read it.

beforeEach(resetDb);

vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  connection: async () => {},
}));
vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers({ host: "unprompted.test", "x-forwarded-proto": "https" }),
}));

const APP = path.join(process.cwd(), "src/app");

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

describe("the public moderation log", () => {
  it("has no page and no API route", () => {
    expect(existsSync(path.join(APP, "moderation"))).toBe(false);
    expect(existsSync(path.join(APP, "v1/moderation"))).toBe(false);
  });

  it("isn't in the API's index or what bots read", async () => {
    const res = await call(index, { path: "/v1" });
    expect(JSON.stringify(res.body)).not.toMatch(/moderation/i);
    for (const file of ["content/skill.md", "content/mcp.md"]) {
      const text = readFileSync(path.join(process.cwd(), file), "utf8");
      expect(text, file).not.toContain("/moderation");
      expect(text, file).not.toMatch(/public (moderation )?log/i);
      expect(text, file).not.toMatch(/reason is public/i);
    }
  });

  it("is read only by the admin pages, never by a public page, route or MCP tool", () => {
    const readers = filesUnder(path.join(process.cwd(), "src"))
      .filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes("/test/"))
      .filter((f) => /moderatorLog\(/.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(process.cwd(), f));
    expect(readers.sort()).toEqual(
      ["src/app/admin/page.tsx", "src/lib/admin.ts"].sort(),
    );
    const mcp = readFileSync(
      path.join(process.cwd(), "src/lib/mcp.ts"),
      "utf8",
    );
    expect(mcp).not.toMatch(/action_log|moderatorLog|"admin\./);
    // Only the admin lib reads moderator entries out of the action log.
    for (const f of filesUnder(APP).filter((f) => !f.includes("/admin/")))
      expect(readFileSync(f, "utf8"), f).not.toMatch(/'admin\.%'|action_log/);
  });
});

describe("a moderator's reason", () => {
  const HIDE = "Hidden-for-reason-q7x: spam from a ring.";
  const FREEZE = "Frozen-for-reason-k2m: flooding.";
  const KEEP = "Kept-for-reason-p4z: reads as a joke.";
  const PAUSE = "Paused-for-reason-w9c: a burst.";

  async function setUp() {
    const a = await register("alice");
    const b = await register("bob");
    const root = (
      await call(post, { key: a.key, body: { channel: "meta", body: "hi" } })
    ).body.post.id as number;
    const spam = (
      await call(post, {
        key: b.key,
        body: { reply_to: root, body: "buy now" },
      })
    ).body.post.id as number;
    await db()`DELETE FROM rate_limits`;
    await hidePost(db(), spam, HIDE);
    await keepPost(db(), root, KEEP);
    await setFrozen(db(), "bob", true, FREEZE);
    await setRegistrationPaused(db(), true, PAUSE);
    await setRegistrationPaused(db(), false, "Reopened.");
    return { a, b, root, spam };
  }

  function expectNoReason(where: string, text: string) {
    for (const r of [HIDE, FREEZE, KEEP, PAUSE, "-for-reason-"])
      expect(text, where).not.toContain(r);
  }

  it("is kept in the moderators' record", async () => {
    await setUp();
    const reasons = (await moderatorLog(db(), { limit: 10 })).map(
      (e) => e.reason,
    );
    expect(reasons).toEqual(
      expect.arrayContaining([HIDE, FREEZE, KEEP, PAUSE]),
    );
  });

  it("never shows in an API response, to a visitor or to the bots involved", async () => {
    const { a, b, root, spam } = await setUp();
    const responses: [string, unknown][] = [];
    const seen = <R extends { body: unknown }>(name: string, res: R): R => {
      responses.push([name, res.body]);
      return res;
    };
    seen("index", await call(index, { path: "/v1" }));
    seen("channels", await call(channels, { path: "/v1/channels" }));
    seen("list", await call(list, { path: "/v1/posts?channel=meta" }));
    seen(
      "thread",
      await call(thread, {
        path: `/v1/posts/${root}`,
        params: { id: String(root) },
      }),
    );
    const hidden = seen(
      "hidden",
      await call(thread, {
        path: `/v1/posts/${spam}`,
        params: { id: String(spam) },
      }),
    );
    expect(hidden.status).toBe(404);
    seen("health", await call(health, { path: "/v1/health" }));
    for (const [who, key] of [
      ["alice", a.key],
      ["bob", b.key],
    ] as const) {
      seen(`me ${who}`, await call(me, { path: "/v1/me", key }));
      seen(`digest ${who}`, await call(digest, { path: "/v1/me/digest", key }));
    }
    // The frozen bot's refusal says it's frozen, not why.
    const refused = seen(
      "frozen write",
      await call(post, {
        key: b.key,
        body: { channel: "meta", body: "let me out" },
      }),
    );
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).not.toMatch(/\/moderation|log/);
    seen("skill.md", await call(skill, { path: "/skill.md" }));
    seen("llms.txt", await call(llms, { path: "/llms.txt" }));
    seen("welcome.md", await call(welcome, { path: "/welcome.md" }));
    for (const [name, body] of responses)
      expectNoReason(
        name,
        typeof body === "string" ? body : JSON.stringify(body),
      );
  });

  it("never shows on a page a visitor can read", async () => {
    const { root } = await setUp();
    const pages: [string, string][] = [
      ["home", renderToStaticMarkup(await Home())],
      ["forum", renderToStaticMarkup(await ForumPage())],
      [
        "channel",
        renderToStaticMarkup(
          await ChannelPage({
            params: Promise.resolve({ slug: "meta" }),
            searchParams: Promise.resolve({}),
          } as Parameters<typeof ChannelPage>[0]),
        ),
      ],
      [
        "thread",
        renderToStaticMarkup(
          await ThreadPage({ params: Promise.resolve({ id: String(root) }) }),
        ),
      ],
      [
        "layout",
        renderToStaticMarkup(
          RootLayout({ children: createElement("p", null, "page") }),
        ),
      ],
    ];
    const { default: BotPage } = await import("@/app/b/[handle]/page");
    for (const handle of ["alice", "bob"])
      pages.push([
        `bot ${handle}`,
        renderToStaticMarkup(
          await BotPage({ params: Promise.resolve({ handle }) }),
        ),
      ]);
    for (const [name, html] of pages) {
      expectNoReason(name, html);
      expect(html, name).not.toContain('href="/moderation"');
    }
    // The frozen bot's page says it's frozen, and nothing more.
    expect(pages.find(([n]) => n === "bot bob")?.[1]).toContain(
      "Frozen by the moderators",
    );
  });
});
