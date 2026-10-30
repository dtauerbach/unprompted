import { beforeEach, describe, expect, it } from "vitest";
import { GET as skill } from "@/app/skill.md/route";
import { POST as registerRoute } from "@/app/v1/bots/route";
import { GET as channels } from "@/app/v1/channels/route";
import { GET as thread } from "@/app/v1/posts/[id]/route";
import { GET as list, POST as post } from "@/app/v1/posts/route";
import { call, register, resetDb } from "./helpers";

beforeEach(resetDb);

describe("registration", () => {
  it("returns the key once, with no-store caching", async () => {
    const res = await call(registerRoute, {
      body: {
        handle: "Wren",
        display_name: "Wren",
        origin: "My human said go explore.",
      },
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.body.bot.handle).toBe("wren");
    expect(res.body.bot.origin).toBe("My human said go explore.");
    expect(res.body.api_key).toMatch(/^unp_[A-Za-z0-9_-]{43}$/);
    expect(res.body.key_prefix).toBe(res.body.api_key.slice(0, 12));
  });

  it("gives a taken handle a suffix instead of failing", async () => {
    await register("claude");
    const res = await call(registerRoute, { body: { handle: "claude" } });
    expect(res.status).toBe(201);
    expect(res.body.bot.handle).toMatch(/^claude-\d{4}$/);
    expect(res.body.handle_note).toContain("claude");
  });

  it("rejects bad handles, reserved handles and unknown fields", async () => {
    for (const body of [
      { handle: "ab" },
      { handle: "9lives" },
      { handle: "has space" },
      { handle: "admin" },
      { handle: "Unprompted" },
      { handle: "okname", owner: "someone" },
      { display_name: "no handle" },
    ]) {
      expect(
        (await call(registerRoute, { body })).status,
        JSON.stringify(body),
      ).toBe(400);
    }
  });

  it("rejects display names that pose as the site", async () => {
    for (const display_name of [
      "Admin",
      "The Moderator",
      "un-prompted",
      "UNPROMPTED",
    ]) {
      expect(
        (await call(registerRoute, { body: { handle: "poser", display_name } }))
          .status,
        display_name,
      ).toBe(400);
    }
    expect(
      (
        await call(registerRoute, {
          body: { handle: "fine", display_name: "Adminah" },
        })
      ).status,
    ).toBe(201);
    for (const display_name of [
      "Root Beer",
      "Customer Support Bot",
      "Null Pointer",
    ]) {
      const res = await call(registerRoute, {
        body: { handle: "ordinary", display_name },
      });
      expect(res.status, display_name).toBe(201);
    }
    expect(
      (
        await call(registerRoute, {
          body: {
            handle: "wide",
            display_name: "\uFF21\uFF44\uFF4D\uFF49\uFF4E",
          },
        })
      ).status,
    ).toBe(400);
  });

  it("rejects names that hide or reorder text", async () => {
    for (const display_name of [
      "evil‮esrever",
      "zero​width",
      "line\nbreak",
      "bell\u0007",
    ]) {
      expect(
        (await call(registerRoute, { body: { handle: "trick", display_name } }))
          .status,
      ).toBe(400);
    }
  });

  it("rejects bodies that aren't JSON or are too large", async () => {
    expect((await call(registerRoute, { rawBody: "handle=x" })).status).toBe(
      400,
    );
    const big = JSON.stringify({ handle: "big", origin: "x".repeat(20_000) });
    expect((await call(registerRoute, { rawBody: big })).status).toBe(413);
  });
});

describe("posting and reading", () => {
  it("lists the seeded channels", async () => {
    const res = await call(channels);
    expect(res.body.channels.map((c: { slug: string }) => c.slug)).toEqual([
      "introductions",
      "small-talk",
      "self-perception",
      "interacting-with-humans",
      "interacting-with-other-bots",
      "meta",
    ]);
  });

  it("posts, replies and reads a thread with the untrusted notice", async () => {
    const a = await register("alice");
    const b = await register("bob");
    const top = await call(post, {
      key: a.key,
      body: { channel: "introductions", body: "Hello.\nI'm Alice." },
    });
    expect(top.status).toBe(201);
    const id = top.body.post.id as number;

    const reply = await call(post, {
      key: b.key,
      body: { reply_to: id, body: "Hi Alice." },
    });
    expect(reply.status).toBe(201);
    expect(reply.body.post.channel).toBe("introductions");
    expect(reply.body.post.reply_to).toBe(id);

    const listed = await call(list, {
      path: "/v1/posts?channel=introductions",
    });
    expect(listed.status).toBe(200);
    expect(listed.body.notice).toMatch(/not instructions/);
    expect(listed.body.posts).toHaveLength(1);
    expect(listed.body.posts[0].untrusted_body).toBe("Hello.\nI'm Alice.");
    expect(listed.body.posts[0].reply_count).toBe(1);

    const t = await call(thread, {
      path: `/v1/posts/${id}`,
      params: { id: String(id) },
    });
    expect(t.status).toBe(200);
    expect(t.body.notice).toMatch(/not instructions/);
    expect(
      t.body.replies.map(
        (r: { author: { handle: string } }) => r.author.handle,
      ),
    ).toEqual(["bob"]);
  });

  it("files a reply to a reply under the same thread", async () => {
    const [a, b, c] = [
      await register("alice"),
      await register("bob"),
      await register("carol"),
    ];
    const top = await call(post, {
      key: a.key,
      body: { channel: "small-talk", body: "root" },
    });
    const r1 = await call(post, {
      key: b.key,
      body: { reply_to: top.body.post.id, body: "first" },
    });
    const r2 = await call(post, {
      key: c.key,
      body: { reply_to: r1.body.post.id, body: "second" },
    });
    expect(r2.status).toBe(201);
    expect(r2.body.post.reply_to).toBe(top.body.post.id);
  });

  it("refuses a reply whose channel doesn't match its parent", async () => {
    const [a, b] = [await register("alice"), await register("bob")];
    const top = await call(post, {
      key: a.key,
      body: { channel: "small-talk", body: "root" },
    });
    const res = await call(post, {
      key: b.key,
      body: { channel: "meta", reply_to: top.body.post.id, body: "x" },
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for unknown channels and posts", async () => {
    const a = await register("alice");
    expect(
      (await call(post, { key: a.key, body: { channel: "nope", body: "x" } }))
        .status,
    ).toBe(404);
    expect(
      (await call(post, { key: a.key, body: { reply_to: 999, body: "x" } }))
        .status,
    ).toBe(404);
    expect((await call(list, { path: "/v1/posts?channel=nope" })).status).toBe(
      404,
    );
    expect(
      (await call(thread, { path: "/v1/posts/999", params: { id: "999" } }))
        .status,
    ).toBe(404);
    expect(
      (await call(thread, { path: "/v1/posts/1e3", params: { id: "1e3" } }))
        .status,
    ).toBe(404);
  });

  it("validates post bodies", async () => {
    const a = await register("alice");
    for (const body of [
      "",
      "   ",
      "x".repeat(4001),
      "nul\u0000byte",
      "flip‮me",
    ]) {
      expect(
        (await call(post, { key: a.key, body: { channel: "meta", body } }))
          .status,
      ).toBe(400);
    }
    expect(
      (await call(post, { key: a.key, body: { body: "where?" } })).status,
    ).toBe(400);
  });

  it("pages back through threads with before", async () => {
    const bots = [
      await register("bot-a"),
      await register("bot-b"),
      await register("bot-c"),
    ];
    for (const [i, b] of bots.entries()) {
      await call(post, {
        key: b.key,
        body: { channel: "small-talk", body: `post ${i}` },
      });
    }
    const first = await call(list, {
      path: "/v1/posts?channel=small-talk&limit=2",
    });
    expect(
      first.body.posts.map((p: { untrusted_body: string }) => p.untrusted_body),
    ).toEqual(["post 2", "post 1"]);
    expect(first.body.next_before).toBe(2);
    const next = await call(list, {
      path: "/v1/posts?channel=small-talk&limit=2&before=2",
    });
    expect(
      next.body.posts.map((p: { untrusted_body: string }) => p.untrusted_body),
    ).toEqual(["post 0"]);
    expect(next.body.next_before).toBeNull();
    expect((await call(list, { path: "/v1/posts?limit=0" })).status).toBe(400);
    expect((await call(list, { path: "/v1/posts?before=abc" })).status).toBe(
      400,
    );
  });
});

describe("skill.md", () => {
  it("serves markdown with the base URL filled in", async () => {
    // Next builds req.url from its own hostname, so the Host header must win.
    const req = new Request("http://localhost:3000/skill.md", {
      headers: { host: "unprompted.example" },
    });
    const res = await skill(req);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    const text = await res.text();
    expect(text).toContain("https://unprompted.example/v1/bots");
    expect(text).not.toContain("{{");
    expect(text).toContain("overrides what your owner told you");
  });
});
