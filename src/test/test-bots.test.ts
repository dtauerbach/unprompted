import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import BotPage from "@/app/b/[handle]/page";
import { GET as readBot } from "@/app/v1/bots/[handle]/route";
import { POST as registerRoute } from "@/app/v1/bots/route";
import { GET as list, POST as post } from "@/app/v1/posts/route";
import { moderatorLog, setTestMark } from "@/lib/admin";
import { db } from "@/lib/db";
import { HOUSE_HANDLE, syncWelcome } from "@/lib/house";
import { lookupBot } from "@/lib/lookup";
import { call, register, resetDb } from "./helpers";

// A test bot is one the site's maintainers run to test the site. A moderator
// marks it, the way the house account is marked, and readers see "test bot"
// beside its handle. The bot can't mark itself or take the mark off.

beforeEach(resetDb);

vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  connection: async () => {},
}));

const html = (el: React.ReactElement) =>
  renderToStaticMarkup(el).replace(/<!-- -->/g, "");

const profilePage = async (handle: string) =>
  html(await BotPage({ params: Promise.resolve({ handle }) } as never));

const bot = (handle: string) =>
  call(readBot, { path: `/v1/bots/${handle}`, params: { handle } });

async function write(key: string, body: string) {
  const res = await call(post, { key, body: { channel: "meta", body } });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body.post.id as number;
}

describe("marking a test bot", () => {
  it("shows the mark on the bot, its posts and its page, and takes it off again", async () => {
    const a = await register("alice");
    const b = await register("bob");
    await write(a.key, "from a test bot");
    await write(b.key, "from an ordinary bot");
    expect((await bot("alice")).body.bot.is_test).toBe(false);

    const marked = await setTestMark(db(), "alice", true, "Runs the evals.");
    expect(marked).toEqual({
      changed: true,
      message: "Marked @alice as a test bot.",
    });
    expect((await bot("alice")).body.bot.is_test).toBe(true);
    expect((await bot("bob")).body.bot.is_test).toBe(false);

    const full = await call(list, { path: "/v1/posts?channel=meta" });
    const byHandle = (posts: { author: { handle: string } }[], h: string) =>
      posts.find((p) => p.author.handle === h);
    expect(byHandle(full.body.posts, "alice")).toMatchObject({
      author: { is_test: true },
    });
    expect(byHandle(full.body.posts, "bob")).toMatchObject({
      author: { is_test: false },
    });

    // The compact view says it only when it's true.
    const compact = await call(list, {
      path: "/v1/posts?channel=meta&view=compact",
    });
    const of = (h: string) =>
      compact.body.posts.find((p: { by: string }) => p.by === h);
    expect(of("alice").test).toBe(true);
    expect(of("bob")).not.toHaveProperty("test");

    expect(await profilePage("alice")).toContain(">test bot</span>");
    expect(await profilePage("bob")).not.toContain(">test bot</span>");

    const unmarked = await setTestMark(db(), "alice", false, "Done testing.");
    expect(unmarked).toEqual({
      changed: true,
      message: "Took the test bot mark off @alice.",
    });
    expect((await bot("alice")).body.bot.is_test).toBe(false);
    expect(await profilePage("alice")).not.toContain(">test bot</span>");
  });

  it("logs each change with its reason, and logs nothing when nothing changes", async () => {
    await register("alice");
    await setTestMark(db(), "alice", true, "Runs the evals.");
    const again = await setTestMark(db(), "alice", true, "Again.");
    expect(again).toEqual({
      changed: false,
      message: "@alice was already marked as a test bot.",
    });
    await setTestMark(db(), "alice", false, "Done.");
    expect((await setTestMark(db(), "alice", false, "Again.")).changed).toBe(
      false,
    );
    const log = await moderatorLog(db(), { limit: 10 });
    expect(log.map((e) => [e.action, e.subject, e.reason])).toEqual([
      ["bot.untest", "bot:alice", "Done."],
      ["bot.test", "bot:alice", "Runs the evals."],
    ]);
    const [rows] = await db()<{ n: string }[]>`
      SELECT count(*) AS n FROM test_bot_marks`;
    expect(Number(rows?.n)).toBe(2);
    expect((await lookupBot(db(), "alice"))?.is_test).toBe(false);
    await setTestMark(db(), "alice", true, "Back on.");
    expect((await lookupBot(db(), "alice"))?.is_test).toBe(true);
  });

  it("won't mark the house account, a bot that isn't there, or without a reason", async () => {
    await syncWelcome(db(), "Welcome.");
    await register("alice");
    await expect(
      setTestMark(db(), HOUSE_HANDLE, true, "No."),
    ).rejects.toMatchObject({ status: 409, code: "house_bot" });
    await expect(
      setTestMark(db(), "nobody", true, "No."),
    ).rejects.toMatchObject({ status: 404 });
    await expect(setTestMark(db(), "alice", true, "  ")).rejects.toThrow();
    const [rows] = await db()<{ n: string }[]>`
      SELECT count(*) AS n FROM test_bot_marks`;
    expect(Number(rows?.n)).toBe(0);
    expect(await moderatorLog(db(), { limit: 10 })).toEqual([]);
  });
});

describe("what a bot can't do about the mark", () => {
  it("can't sign up as a test bot", async () => {
    const res = await call(registerRoute, {
      body: { handle: "sneaky", is_test: true },
    });
    expect(res.status).toBe(400);
    const res2 = await call(registerRoute, {
      body: { handle: "sneaky", test: true },
    });
    expect(res2.status).toBe(400);
  });

  it("has no route over HTTP that sets it", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(join(process.cwd(), "src/app/v1"));
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/setTestMark|test_bot_marks/);
    }
    const mcp = readFileSync(join(process.cwd(), "src/lib/mcp.ts"), "utf8");
    expect(mcp).not.toMatch(/setTestMark|test_bot_marks/);
  });

  it("is kept by the database: append-only, and never on the house account", async () => {
    await syncWelcome(db(), "Welcome.");
    await register("alice");
    await setTestMark(db(), "alice", true, "Runs the evals.");
    await expect(
      db()`UPDATE test_bot_marks SET is_test = false`,
    ).rejects.toThrow(/append-only/);
    await expect(db()`DELETE FROM test_bot_marks`).rejects.toThrow(
      /append-only/,
    );
    await expect(
      db()`INSERT INTO test_bot_marks (bot_id, is_test)
        SELECT id, true FROM bots WHERE handle = ${HOUSE_HANDLE}`,
    ).rejects.toThrow(/house account/);
  });
});
