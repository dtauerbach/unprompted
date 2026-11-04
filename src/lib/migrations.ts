import { createHash } from "node:crypto";
import postgres from "postgres";

export type Migration = { name: string; sql: string };

export type MigrationOptions = {
  // Which kind of deploy is applying them (Vercel's VERCEL_ENV), kept with
  // each row so a preview can tell its own migrations from the ones it
  // inherited from production when its Neon branch was made.
  appliedIn?: string;
  // A preview stops, before applying anything, when an earlier build of it
  // ran one of its migrations whose file has since changed, or that has since
  // been renamed or removed. Anything else only warns.
  refuseDrift?: boolean;
};

export type MigrationResult = {
  applied: string[];
  // Applied by an earlier build of this same preview, and the file's SQL has
  // changed since. A preview refuses these: resetting its branch fixes it.
  changed: string[];
  // Applied elsewhere (production), and the file's SQL has changed since: an
  // edit to a merged migration, which never reaches a database that ran it.
  // Only a warning, since resetting a preview wouldn't help; production then
  // records the new hash, so branches made from it later don't inherit the
  // warning. CI stops such an edit before it merges (scripts/check-migrations.ts).
  edited: string[];
  // Applied by an earlier preview build of this same branch, and gone now.
  vanished: string[];
  // Applied elsewhere (production, usually a migration merged after this
  // branch was cut), and not in this checkout. Normal; never an error.
  unknown: string[];
};

export class MigrationDriftError extends Error {
  constructor(
    readonly changed: string[],
    readonly vanished: string[],
  ) {
    const parts = [
      changed.length
        ? `already ran an older version of ${changed.join(", ")}`
        : "",
      vanished.length
        ? `ran ${vanished.join(", ")}, which this branch no longer has`
        : "",
    ].filter(Boolean);
    super(`This database ${parts.join(", and ")}.`);
    this.name = "MigrationDriftError";
  }
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// A transaction-level advisory lock keeps two concurrent deploys from racing,
// and is released on commit even through a transaction-mode pooler.
const LOCK_ID = 7_301_984;

export async function applyMigrations(
  url: string,
  migrations: Migration[],
  options: MigrationOptions = {},
): Promise<MigrationResult> {
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    return await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${LOCK_ID})`;
      await tx`CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`;
      // Added later, so rows from before carry neither: a row with no hash
      // takes the file's hash the first time it's checked, which trusts
      // whatever the database already ran up to now.
      await tx`ALTER TABLE schema_migrations
        ADD COLUMN IF NOT EXISTS sha256 text,
        ADD COLUMN IF NOT EXISTS applied_in text`;
      const rows = await tx<
        { name: string; sha256: string | null; applied_in: string | null }[]
      >`SELECT name, sha256, applied_in FROM schema_migrations`;
      const done = new Map(rows.map((r) => [r.name, r]));
      const files = new Map(migrations.map((m) => [m.name, sha256(m.sql)]));

      // Rows this kind of deploy applied itself, on a database that refuses
      // drift (a preview's own branch). Anything else came with the branch.
      const own = (row: { applied_in: string | null }) =>
        Boolean(options.refuseDrift) &&
        row.applied_in !== null &&
        row.applied_in === options.appliedIn;
      const changed: string[] = [];
      const edited: string[] = [];
      for (const [name, hash] of files) {
        const row = done.get(name);
        if (!row) continue;
        if (row.sha256 === null)
          await tx`UPDATE schema_migrations SET sha256 = ${hash} WHERE name = ${name}`;
        else if (row.sha256 === hash) continue;
        else if (own(row)) changed.push(name);
        else {
          edited.push(name);
          if (options.appliedIn !== "preview")
            await tx`UPDATE schema_migrations SET sha256 = ${hash} WHERE name = ${name}`;
        }
      }
      const vanished: string[] = [];
      const unknown: string[] = [];
      for (const row of rows) {
        if (files.has(row.name)) continue;
        if (own(row)) vanished.push(row.name);
        else unknown.push(row.name);
      }
      changed.sort();
      edited.sort();
      vanished.sort();
      unknown.sort();
      if (options.refuseDrift && (changed.length || vanished.length))
        throw new MigrationDriftError(changed, vanished);

      const applied: string[] = [];
      for (const m of migrations) {
        if (done.has(m.name)) continue;
        await tx.unsafe(m.sql);
        await tx`INSERT INTO schema_migrations (name, sha256, applied_in)
          VALUES (${m.name}, ${files.get(m.name) ?? null}, ${options.appliedIn ?? null})`;
        applied.push(m.name);
      }
      return { applied, changed, edited, vanished, unknown };
    });
  } finally {
    await sql.end();
  }
}
