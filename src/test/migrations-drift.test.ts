import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, MigrationDriftError, sha256 } from "@/lib/migrations";
import { testDatabaseUrl } from "./global-setup";

// The migration runner, against a scratch database of its own so the shared
// test database's schema is left alone. A preview's Neon branch starts as a
// copy of production; when a pull request then edits or renames a migration
// it already ran there, the preview stops with a plain message instead of
// failing on leftover tables.

const base = new URL(testDatabaseUrl());
const scratchName = `${base.pathname.slice(1)}_migrations_test`;
const scratch = new URL(base);
scratch.pathname = `/${scratchName}`;
const url = scratch.toString();

let admin: postgres.Sql;
let sql: postgres.Sql;

beforeAll(async () => {
  admin = postgres(base.toString(), { max: 1, onnotice: () => {} });
  const exists =
    await admin`SELECT 1 FROM pg_database WHERE datname = ${scratchName}`;
  if (!exists.length) await admin.unsafe(`CREATE DATABASE "${scratchName}"`);
  sql = postgres(url, { max: 1, onnotice: () => {} });
});

afterAll(async () => {
  await sql?.end();
  await admin?.end();
});

beforeEach(async () => {
  await sql`DROP SCHEMA public CASCADE`;
  await sql`CREATE SCHEMA public`;
});

const m1 = { name: "001_a.sql", sql: "CREATE TABLE a (id int);" };
const m2 = { name: "002_b.sql", sql: "CREATE TABLE b (id int);" };
const m2edited = { name: "002_b.sql", sql: "CREATE TABLE b (id int, x int);" };
const m2renamed = { name: "002_bee.sql", sql: "CREATE TABLE b (id int);" };

const rows = () =>
  sql<{ name: string; sha256: string | null; applied_in: string | null }[]>`
    SELECT name, sha256, applied_in FROM schema_migrations ORDER BY name`;

describe("applying migrations", () => {
  it("applies each once, in order, recording its hash and where it ran", async () => {
    const first = await applyMigrations(url, [m1, m2], {
      appliedIn: "production",
    });
    expect(first).toEqual({
      applied: ["001_a.sql", "002_b.sql"],
      changed: [],
      edited: [],
      vanished: [],
      unknown: [],
    });
    expect(await rows()).toEqual([
      { name: "001_a.sql", sha256: sha256(m1.sql), applied_in: "production" },
      { name: "002_b.sql", sha256: sha256(m2.sql), applied_in: "production" },
    ]);
    const again = await applyMigrations(url, [m1, m2]);
    expect(again.applied).toEqual([]);
  });

  it("gives rows from before hashes the file's hash, and no drift", async () => {
    await sql`CREATE TABLE schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    await sql.unsafe(m1.sql);
    await sql`INSERT INTO schema_migrations (name) VALUES ('001_a.sql')`;
    const r = await applyMigrations(url, [m1, m2], {
      appliedIn: "preview",
      refuseDrift: true,
    });
    expect(r.applied).toEqual(["002_b.sql"]);
    expect(r.changed).toEqual([]);
    expect((await rows())[0]).toEqual({
      name: "001_a.sql",
      sha256: sha256(m1.sql),
      applied_in: null,
    });
  });

  it("stops a preview, writing nothing, when one of its migrations was edited", async () => {
    await applyMigrations(url, [m1, m2], { appliedIn: "preview" });
    const m3 = { name: "003_c.sql", sql: "CREATE TABLE c (id int);" };
    const err = await applyMigrations(url, [m1, m2edited, m3], {
      appliedIn: "preview",
      refuseDrift: true,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(MigrationDriftError);
    expect(err.changed).toEqual(["002_b.sql"]);
    expect(err.message).toContain("already ran an older version of 002_b.sql");
    // Nothing after the check ran: no table c, no row for 003.
    expect((await rows()).map((r) => r.name)).toEqual([
      "001_a.sql",
      "002_b.sql",
    ]);
    expect((await sql`SELECT to_regclass('public.c') AS t`)[0]?.t).toBeNull();
  });

  it("stops a preview whose own earlier migration was renamed away", async () => {
    await applyMigrations(url, [m1], { appliedIn: "production" });
    await applyMigrations(url, [m1, m2], { appliedIn: "preview" });
    const err = await applyMigrations(url, [m1, m2renamed], {
      appliedIn: "preview",
      refuseDrift: true,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(MigrationDriftError);
    expect(err.vanished).toEqual(["002_b.sql"]);
    expect(err.message).toMatch(
      /ran 002_b\.sql, which this branch no longer has/,
    );
  });

  it("lets a preview run when production has migrations this branch doesn't", async () => {
    // Production ran 001 and 002; a pull request cut before 002 merged adds 003.
    await applyMigrations(url, [m1, m2], { appliedIn: "production" });
    const m3 = { name: "003_c.sql", sql: "CREATE TABLE c (id int);" };
    const r = await applyMigrations(url, [m1, m3], {
      appliedIn: "preview",
      refuseDrift: true,
    });
    expect(r).toEqual({
      applied: ["003_c.sql"],
      changed: [],
      edited: [],
      vanished: [],
      unknown: ["002_b.sql"],
    });
  });

  it("stops any drift-refusing deploy on a migration it ran itself, not only a preview", async () => {
    // A development or custom Vercel environment on its own branch.
    await applyMigrations(url, [m1, m2], { appliedIn: "development" });
    const err = await applyMigrations(url, [m1, m2edited], {
      appliedIn: "development",
      refuseDrift: true,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(MigrationDriftError);
    expect(err.changed).toEqual(["002_b.sql"]);
  });

  it("never stops a deploy that doesn't refuse drift, even on its own rows", async () => {
    await applyMigrations(url, [m1, m2], { appliedIn: "preview" });
    const r = await applyMigrations(url, [m1, m2edited], {
      appliedIn: "preview",
    });
    expect(r.changed).toEqual([]);
    expect(r.edited).toEqual(["002_b.sql"]);
  });

  it("only warns a preview when a migration it inherited was edited", async () => {
    // Resetting the preview wouldn't help: it would inherit the same row.
    await applyMigrations(url, [m1, m2], { appliedIn: "production" });
    const r = await applyMigrations(url, [m1, m2edited], {
      appliedIn: "preview",
      refuseDrift: true,
    });
    expect(r.changed).toEqual([]);
    expect(r.edited).toEqual(["002_b.sql"]);
  });

  it("warns production about an edited migration, then records the new hash", async () => {
    await applyMigrations(url, [m1, m2], { appliedIn: "production" });
    const m3 = { name: "003_c.sql", sql: "CREATE TABLE c (id int);" };
    const r = await applyMigrations(url, [m1, m2edited, m3], {
      appliedIn: "production",
    });
    expect(r.edited).toEqual(["002_b.sql"]);
    expect(r.changed).toEqual([]);
    expect(r.applied).toEqual(["003_c.sql"]);
    // So branches made from production later don't inherit the warning.
    expect((await rows())[1]?.sha256).toBe(sha256(m2edited.sql));
    const again = await applyMigrations(url, [m1, m2edited, m3], {
      appliedIn: "preview",
      refuseDrift: true,
    });
    expect(again.edited).toEqual([]);
  });

  it("rolls back every migration in a run when one fails", async () => {
    const bad = { name: "002_bad.sql", sql: "CREATE TABLE a (id int);" };
    await expect(applyMigrations(url, [m1, bad])).rejects.toThrow();
    expect(
      (await sql`SELECT to_regclass('public.schema_migrations') AS t`)[0]?.t,
    ).toBeNull();
  });
});
