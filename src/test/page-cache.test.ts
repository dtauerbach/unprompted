import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as post } from "@/app/v1/posts/route";
import { addAdmin } from "@/lib/admins";
import { COPY, saveCopy } from "@/lib/copy";
import { closeDb, db } from "@/lib/db";
import { homeStats } from "@/lib/home-stats";
import { pageCopy } from "@/lib/page-copy";
import { COPY_TAG, pageCacheSeconds } from "@/lib/shared-cache";
import { call, register, resetDb } from "./helpers";
import { cacheClock, revalidateTag, updateTag } from "./next-cache";

// The words on people's pages and the home page's counts come from Next's
// cross-request cache, so drawing a page doesn't wake the database. Saves
// that go through Next clear the words; a time limit catches the rest.

vi.mock("@/lib/db", async (original) => {
  const real = await original<typeof import("@/lib/db")>();
  return { ...real, db: vi.fn(real.db) };
});
// Pages wait for a request before reading the database; here there is none.
vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  connection: async () => {},
}));

beforeEach(resetDb);
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.UNPROMPTED_PAGE_CACHE_SECONDS;
});

async function trips(fn: () => Promise<unknown>): Promise<number> {
  const before = vi.mocked(db).mock.calls.length;
  await fn();
  return vi.mocked(db).mock.calls.length - before;
}

async function admin(): Promise<number> {
  return (await addAdmin(db(), { authUserId: "google-admin" }, "Admin.", "x"))
    .humanId;
}

async function save(humanId: number, key: "home.tagline", body: string) {
  const [row] = await db()<{ id: string }[]>`
    SELECT id FROM copy_versions WHERE key = ${key} ORDER BY id DESC LIMIT 1`;
  return saveCopy(db(), {
    key,
    body,
    after: row ? Number(row.id) : 0,
    editor: { humanId, role: "admin", keyId: null },
    ipHash: null,
  });
}

function later(seconds: number) {
  const now = Date.now();
  vi.spyOn(cacheClock, "now").mockReturnValue(now + seconds * 1000);
}

describe("the words on people's pages", () => {
  it("are read once, then drawn without the database", async () => {
    expect(await trips(pageCopy)).toBeGreaterThan(0);
    expect(await trips(pageCopy)).toBe(0);
    expect((await pageCopy())["home.tagline"]).toBe(COPY["home.tagline"].text);
  });

  it("change at once when a save clears the tag, and not before", async () => {
    const humanId = await admin();
    await pageCopy();
    await save(humanId, "home.tagline", "Bots at play.");
    // A save outside Next (the command line) can't clear it...
    expect((await pageCopy())["home.tagline"]).toBe(COPY["home.tagline"].text);
    // ...an admin's save (updateTag) and a copy key's (revalidateTag) do.
    updateTag(COPY_TAG);
    expect((await pageCopy())["home.tagline"]).toBe("Bots at play.");
    await save(humanId, "home.tagline", "Bots at work.");
    revalidateTag(COPY_TAG, { expire: 0 });
    expect((await pageCopy())["home.tagline"]).toBe("Bots at work.");
  });

  it("change after the time limit when nothing clears them", async () => {
    const humanId = await admin();
    await pageCopy();
    await save(humanId, "home.tagline", "Bots at play.");
    later(pageCacheSeconds() - 5);
    expect((await pageCopy())["home.tagline"]).toBe(COPY["home.tagline"].text);
    later(pageCacheSeconds() + 1);
    expect((await pageCopy())["home.tagline"]).toBe("Bots at play.");
  });

  it("keep only versions that pass the copy rules", async () => {
    const humanId = await admin();
    // Rows a check would refuse, written straight into the store: one that
    // drops the page's link and one with a spot its page doesn't fill.
    await db()`
      INSERT INTO copy_versions (key, body, human_id) VALUES
        ('home.paste_line', 'Sign up somewhere else', ${humanId}),
        ('home.tagline', 'Bots {link} play.', ${humanId})`;
    const t = await pageCopy();
    expect(t["home.paste_line"]).toBe(COPY["home.paste_line"].text);
    expect(t["home.tagline"]).toBe(COPY["home.tagline"].text);
  });

  it("fall back to the built-in words when the database can't be read, without keeping them", async () => {
    const humanId = await admin();
    await save(humanId, "home.tagline", "Saved words.");
    const url = process.env.DATABASE_URL;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await closeDb();
    process.env.DATABASE_URL = "postgres://nobody:x@127.0.0.1:1/nowhere_test";
    try {
      expect((await pageCopy())["home.tagline"]).toBe(
        COPY["home.tagline"].text,
      );
      expect(error).toHaveBeenCalled();
    } finally {
      await closeDb();
      process.env.DATABASE_URL = url;
    }
    expect((await pageCopy())["home.tagline"]).toBe("Saved words.");
  });

  it("take their time limit from the server's setting, a few minutes by default", () => {
    expect(pageCacheSeconds()).toBe(300);
    process.env.UNPROMPTED_PAGE_CACHE_SECONDS = "2";
    expect(pageCacheSeconds()).toBe(2);
    for (const bad of ["0", "-4", "1.5", "soon", ""]) {
      process.env.UNPROMPTED_PAGE_CACHE_SECONDS = bad;
      expect(pageCacheSeconds(), bad).toBe(300);
    }
  });
});

describe("the home page's counts", () => {
  it("are kept for the time limit, then counted again", async () => {
    const a = await register("alice");
    expect((await homeStats()).bots).toBe(1);
    await register("bob");
    const res = await call(post, {
      key: a.key,
      body: { channel: "meta", body: "hello" },
    });
    expect(res.status).toBe(201);
    expect(await trips(homeStats)).toBe(0);
    expect(await homeStats()).toEqual({
      bots: 1,
      posts: 0,
      posts_this_week: 0,
    });
    later(pageCacheSeconds() + 1);
    expect(await homeStats()).toEqual({
      bots: 2,
      posts: 1,
      posts_this_week: 1,
    });
  });
});
