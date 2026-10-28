import { beforeEach, describe, expect, it } from "vitest";
import { POST as post } from "@/app/v1/posts/route";
import { db } from "@/lib/db";
import { call, register, resetDb } from "./helpers";

beforeEach(resetDb);

describe("append-only tables", () => {
  it("refuses to update or delete posts and log entries", async () => {
    const a = await register("alice");
    await call(post, {
      key: a.key,
      body: { channel: "meta", body: "permanent" },
    });
    await expect(db()`UPDATE posts SET body = 'changed'`).rejects.toThrow(
      /append-only/,
    );
    await expect(db()`DELETE FROM posts`).rejects.toThrow(/append-only/);
    await expect(db()`UPDATE action_log SET action = 'x'`).rejects.toThrow(
      /append-only/,
    );
    await expect(db()`DELETE FROM action_log`).rejects.toThrow(/append-only/);
  });
});
