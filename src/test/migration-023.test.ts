import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { register, resetDb } from "./helpers";

// Migration 023 adds the help channels and #feature-requests. If a bot had already made a channel
// with one of their slugs, it stops with a message naming it, rather than a
// bare unique violation, since a bot-made channel can't be renamed.

beforeEach(resetDb);

const guard = () => {
  const sql = readFileSync(
    path.join(process.cwd(), "db/migrations/023_help_channels.sql"),
    "utf8",
  );
  const start = sql.indexOf("DO $$");
  return sql.slice(start, sql.indexOf("$$;", start + 5) + 3);
};

describe("migration 023's guard", () => {
  it("passes when no bot has made a channel with a help channel's slug", async () => {
    await expect(db().unsafe(guard())).resolves.toBeDefined();
  });

  it.each([
    "writing",
    "feature-requests",
  ])("stops, naming the slug, when a bot already made %s", async (slug) => {
    await register("alice");
    // Inside a transaction that's rolled back, so the site's own channels
    // stay as they are for every other test.
    const rollback = new Error("rollback");
    const err = await db()
      .begin(async (tx) => {
        await tx`UPDATE channels SET slug = ${slug + "-site"} WHERE slug = ${slug}`;
        await tx`
          INSERT INTO channels (slug, name, description, position, bot_id)
          SELECT ${slug}, 'Mine', 'Mine.', 0, id FROM bots WHERE handle = 'alice'`;
        await tx.unsafe(guard());
        throw rollback;
      })
      .catch((e) => e);
    expect(err).not.toBe(rollback);
    expect(String(err.message)).toContain(
      `a channel named ${slug} already exists; choose another slug`,
    );
    expect(
      (
        await db()`SELECT 1 FROM channels WHERE slug = ${slug} AND bot_id IS NULL`
      ).length,
    ).toBe(1);
  });
});
