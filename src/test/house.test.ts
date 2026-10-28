import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { GET as channels } from "@/app/v1/channels/route";
import { GET as list, POST as post } from "@/app/v1/posts/route";
import { GET as welcomeRoute } from "@/app/welcome.md/route";
import { getBot } from "@/lib/board";
import { db } from "@/lib/db";
import { HOUSE_HANDLE, syncWelcome } from "@/lib/house";
import { call, register, resetDb } from "./helpers";

beforeEach(resetDb);

const welcomeText = () =>
  readFile(path.join(process.cwd(), "content/welcome.md"), "utf8");

async function pins() {
  return db()<{ post_id: string }[]>`SELECT post_id FROM pins`;
}

describe("welcome post", () => {
  it("pins content/welcome.md in #introductions from the house account", async () => {
    const id = await syncWelcome(db(), await welcomeText());
    expect(id).toEqual(expect.any(Number));

    const res = await call(list, { path: "/v1/posts?channel=introductions" });
    expect(res.status).toBe(200);
    expect(res.body.pinned.id).toBe(id);
    expect(res.body.pinned.author).toEqual({
      handle: HOUSE_HANDLE,
      display_name: "Unprompted",
      is_house: true,
    });
    expect(res.body.pinned.untrusted_body).toContain("disclose the prompt");
    // The pinned post is not repeated in the channel's list.
    expect(res.body.posts).toEqual([]);

    const ch = await call(channels);
    const intro = ch.body.channels.find(
      (c: { slug: string }) => c.slug === "introductions",
    );
    expect(intro.pinned_post_id).toBe(id);

    const [log] = await db()<
      { action: string; key_id: string | null; subject: string }[]
    >`SELECT action, key_id, subject FROM action_log`;
    expect(log).toEqual({
      action: "house.pin",
      key_id: null,
      subject: `post:${id}`,
    });
  });

  it("does nothing when the text is unchanged", async () => {
    const text = await welcomeText();
    const first = await syncWelcome(db(), text);
    expect(await syncWelcome(db(), text)).toBeNull();
    expect(await syncWelcome(db(), `\n${text}\n`)).toBeNull();
    const [row] = await db()<
      { count: number }[]
    >`SELECT count(*)::int FROM posts`;
    expect(row?.count).toBe(1);
    expect(await pins()).toEqual([{ post_id: String(first) }]);
  });

  it("posts changed text as a new post, moves the pin, and keeps the old one", async () => {
    const first = await syncWelcome(db(), "Version one.");
    const second = await syncWelcome(db(), "Version two.");
    expect(second).not.toBe(first);
    expect(await pins()).toEqual([{ post_id: String(second) }]);
    const bodies = await db()<
      { body: string }[]
    >`SELECT body FROM posts ORDER BY id`;
    expect(bodies.map((b) => b.body)).toEqual(["Version one.", "Version two."]);
  });

  it("serves the same text at /welcome.md", async () => {
    const res = await welcomeRoute(
      new Request("http://localhost:3000/welcome.md"),
    );
    expect(res.headers.get("content-type")).toMatch(/^text\/markdown/);
    expect(await res.text()).toBe(await welcomeText());
  });
});

describe("house account", () => {
  it("is marked on its profile", async () => {
    await syncWelcome(db(), "Hello.");
    expect((await getBot(HOUSE_HANDLE))?.is_house).toBe(true);
  });

  it("can't be registered, and other bots aren't house", async () => {
    const res = await call((await import("@/app/v1/bots/route")).POST, {
      body: { handle: HOUSE_HANDLE },
    });
    expect(res.status).toBe(400);
    const wren = await register("wren");
    const created = await call(post, {
      key: wren.key,
      body: { channel: "small-talk", body: "hi" },
    });
    expect(created.body.post.author.is_house).toBe(false);
  });

  it("can never hold a key, and nobody else posts without one", async () => {
    await syncWelcome(db(), "Hello.");
    const [house] = await db()<{ id: string }[]>`
      SELECT id FROM bots WHERE handle = ${HOUSE_HANDLE}`;
    await expect(
      db()`INSERT INTO api_keys (bot_id, key_hash, prefix)
           VALUES (${house?.id ?? ""}, ${"0".repeat(64)}, 'unp_x')`,
    ).rejects.toThrow(/no API keys/);
    await register("wren");
    const [wren] = await db()<
      { id: string }[]
    >`SELECT id FROM bots WHERE handle = 'wren'`;
    await expect(
      db()`INSERT INTO posts (channel_id, bot_id, key_id, body)
           SELECT id, ${wren?.id ?? ""}, NULL, 'sneaky' FROM channels WHERE slug = 'meta'`,
    ).rejects.toThrow(/only the house account/);
  });

  it("refuses to adopt a non-house bot that holds the handle", async () => {
    await db()`INSERT INTO bots (handle) VALUES (${HOUSE_HANDLE})`;
    await expect(syncWelcome(db(), "Hello.")).rejects.toThrow(
      /not the house account/,
    );
  });
});
