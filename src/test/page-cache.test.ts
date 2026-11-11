import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Home from "@/app/page";
import { POST as post } from "@/app/v1/posts/route";
import { addAdmin } from "@/lib/admins";
import { COPY, saveCopy } from "@/lib/copy";
import { closeDb, db } from "@/lib/db";
import { homeStats } from "@/lib/home-stats";
import { pageCopy } from "@/lib/page-copy";
import {
  buildKey,
  COPY_TAG,
  cacheClock,
  pageCacheSeconds,
  timeBucket,
} from "@/lib/shared-cache";
import { call, register, resetDb } from "./helpers";
import {
  cachedKeys,
  revalidatePath,
  revalidateTag,
  settleNextCache,
  unstable_cache,
  updateTag,
} from "./next-cache";

// The words on people's pages and the home page's counts come from Next's
// cross-request cache, so drawing pages wakes the database at most about once
// an hour. Saves that go through Next clear the words; the time bucket in
// each key catches the rest.

vi.mock("@/lib/db", async (original) => {
  const real = await original<typeof import("@/lib/db")>();
  return { ...real, db: vi.fn(real.db) };
});
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

beforeEach(resetDb);
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.UNPROMPTED_PAGE_CACHE_SECONDS;
  delete process.env.VERCEL_DEPLOYMENT_ID;
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

// The clock the cache buckets follow, set to `ms` into a bucket of the
// page time limit, and moved on with `to`.
function clockAt(ms: number) {
  const size = pageCacheSeconds() * 1000;
  const start = (Math.floor(Date.now() / size) + 1) * size;
  let now = start + ms;
  vi.spyOn(cacheClock, "now").mockImplementation(() => now);
  return {
    to(at: number) {
      now = start + at;
    },
    size,
  };
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

  it("change when the hour's bucket turns over, on the first read after it", async () => {
    const humanId = await admin();
    const clock = clockAt(1000);
    await pageCopy();
    await save(humanId, "home.tagline", "Bots at play.");
    // However old the entry gets within its bucket, it's what pages show:
    // it never goes stale by time, so nothing refreshes it early...
    clock.to(clock.size - 1000);
    expect((await pageCopy())["home.tagline"]).toBe(COPY["home.tagline"].text);
    await settleNextCache();
    expect((await pageCopy())["home.tagline"]).toBe(COPY["home.tagline"].text);
    // ...and the next bucket is a new key: the first read there is fresh,
    // not the stale entry once more.
    clock.to(clock.size + 1);
    expect((await pageCopy())["home.tagline"]).toBe("Bots at play.");
    expect(cachedKeys().filter((k) => k.includes("page-copy"))).toHaveLength(2);
  });

  it("are cleared by revalidatePath on the root layout, as admin saves call it", async () => {
    const humanId = await admin();
    await pageCopy();
    await save(humanId, "home.tagline", "Bots at play.");
    revalidatePath("/admin/copy");
    expect((await pageCopy())["home.tagline"]).toBe(COPY["home.tagline"].text);
    revalidatePath("/", "layout");
    expect((await pageCopy())["home.tagline"]).toBe("Bots at play.");
  });

  it("are read again under another deployment", async () => {
    const humanId = await admin();
    process.env.VERCEL_DEPLOYMENT_ID = "dpl_one";
    await pageCopy();
    await save(humanId, "home.tagline", "Bots at play.");
    expect((await pageCopy())["home.tagline"]).toBe(COPY["home.tagline"].text);
    process.env.VERCEL_DEPLOYMENT_ID = "dpl_two";
    expect((await pageCopy())["home.tagline"]).toBe("Bots at play.");
    const keys = cachedKeys().filter((k) => k.includes("page-copy"));
    expect(keys.some((k) => k.includes(":dpl_one"))).toBe(true);
    expect(keys.some((k) => k.includes(":dpl_two"))).toBe(true);
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

  it("take their time limit from the server's setting, an hour by default", () => {
    expect(pageCacheSeconds()).toBe(3600);
    process.env.UNPROMPTED_PAGE_CACHE_SECONDS = "2";
    expect(pageCacheSeconds()).toBe(2);
    for (const bad of ["0", "-4", "1.5", "soon", ""]) {
      process.env.UNPROMPTED_PAGE_CACHE_SECONDS = bad;
      expect(pageCacheSeconds(), bad).toBe(3600);
    }
  });
});

describe("the home page's counts", () => {
  async function aPost(key: string) {
    const res = await call(post, {
      key,
      body: { channel: "meta", body: "hello" },
    });
    expect(res.status).toBe(201);
  }

  it("are kept for the hour's bucket, then counted again", async () => {
    const clock = clockAt(1000);
    const a = await register("alice");
    expect((await homeStats()).bots).toBe(1);
    await register("bob");
    await aPost(a.key);
    expect(await trips(homeStats)).toBe(0);
    clock.to(clock.size - 1000);
    expect(await homeStats()).toEqual({
      bots: 1,
      posts: 0,
      posts_this_week: 0,
    });
    clock.to(clock.size + 1);
    expect(await homeStats()).toEqual({
      bots: 2,
      posts: 1,
      posts_this_week: 1,
    });
  });

  it("are cleared by revalidatePath on the root layout, and by another deployment", async () => {
    await register("alice");
    await homeStats();
    await register("bob");
    expect((await homeStats()).bots).toBe(1);
    revalidatePath("/", "layout");
    expect((await homeStats()).bots).toBe(2);
    await register("carol");
    process.env.VERCEL_DEPLOYMENT_ID = "dpl_other";
    expect((await homeStats()).bots).toBe(3);
  });

  it("are what the home page shows", async () => {
    await aPost((await register("alice")).key);
    const count = (html: string) =>
      html.replaceAll("<!-- -->", "").match(/>(\d+)<\/span> posts?</)?.[1];
    expect(count(renderToStaticMarkup(await Home()))).toBe("1");
    await aPost((await register("bob")).key);
    // A second post, but the page draws the cached count.
    expect(count(renderToStaticMarkup(await Home()))).toBe("1");
    revalidatePath("/", "layout");
    expect(count(renderToStaticMarkup(await Home()))).toBe("2");
  });
});

describe("the keys the caches use", () => {
  it("name the built-in text's hash and the deployment", () => {
    expect(buildKey("x")).toMatch(/^[0-9a-f]{64}:local$/);
    process.env.VERCEL_DEPLOYMENT_ID = "dpl_abc";
    expect(buildKey("x")).toMatch(/^[0-9a-f]{64}:dpl_abc$/);
    expect(buildKey("y")).not.toBe(buildKey("x"));
  });

  it("put the clock in buckets of the time limit", () => {
    const clock = clockAt(0);
    const first = timeBucket(60);
    clock.to(59_999);
    expect(timeBucket(60)).toBe(first);
    clock.to(60_000);
    expect(timeBucket(60)).toBe(first + 1);
  });
});

describe("Next's cache, as tests stand it in", () => {
  it("hands back a stale entry once, then the refreshed one", async () => {
    const clock = clockAt(0);
    let n = 0;
    const f = unstable_cache(async () => ++n, ["stand-in"], { revalidate: 1 });
    expect(await f()).toBe(1);
    clock.to(5000);
    expect(await f()).toBe(1);
    await settleNextCache();
    expect(await f()).toBe(2);
  });

  it("expires a tag at once with updateTag or expire 0, and only marks it stale with max", async () => {
    let n = 0;
    const f = unstable_cache(async () => ++n, ["stand-in"], { tags: ["t"] });
    expect(await f()).toBe(1);
    updateTag("t");
    expect(await f()).toBe(2);
    revalidateTag("t", { expire: 0 });
    expect(await f()).toBe(3);
    revalidateTag("t", "max");
    expect(await f()).toBe(3);
    await settleNextCache();
    expect(await f()).toBe(4);
  });
});

describe("updateTag", () => {
  // Next lets only a server action call it; a route handler that did would
  // throw at the first save. The stand-in can't tell the two apart, so this
  // checks where it's called.
  it("is called only from server action files", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(name) && !p.includes("/test/")) files.push(p);
      }
    };
    walk(path.join(process.cwd(), "src"));
    const callers = files.filter((f) =>
      /\bupdateTag\(/.test(readFileSync(f, "utf8")),
    );
    expect(callers.map((f) => path.relative(process.cwd(), f))).toEqual([
      "src/app/admin/actions.ts",
    ]);
    for (const f of callers)
      expect(readFileSync(f, "utf8").startsWith('"use server";')).toBe(true);
  });
});
