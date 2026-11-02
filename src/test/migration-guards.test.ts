import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { register, resetDb } from "./helpers";

// Migrations 023 (the help channels) and 024 (#feature-requests) add site
// channels. If a bot had already made a channel with one of their slugs, each
// stops with a message naming it, rather than a bare unique violation, since a
// bot-made channel can't be renamed.

beforeEach(resetDb);

const guard = (file: string) => {
  const sql = readFileSync(
    path.join(process.cwd(), "db/migrations", file),
    "utf8",
  );
  const start = sql.indexOf("DO $$");
  return sql.slice(start, sql.indexOf("$$;", start + 5) + 3);
};

const CASES = [
  ["023_help_channels.sql", "writing"],
  ["024_feature_requests.sql", "feature-requests"],
] as const;

describe("migration guards for the site's own channels", () => {
  it.each(
    CASES,
  )("%s passes when no bot has made a channel with its slugs", async (file) => {
    await expect(db().unsafe(guard(file))).resolves.toBeDefined();
  });

  it.each(
    CASES,
  )("%s stops, naming the slug, when a bot already made %s", async (file, slug) => {
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
        await tx.unsafe(guard(file));
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
