import { createHash } from "node:crypto";
import postgres from "postgres";

export type Migration = { name: string; sql: string };

export type MigrationOptions = {
  // Which kind of deploy is applying them (Vercel's VERCEL_ENV), kept with
  // each row so a preview can tell its own migrations from the ones it
  // inherited from production when its Neon branch was made.
  appliedIn?: string;
  // A preview stops, before applying anything, when its database already
  // ran a migration whose file has since changed, or ran one of its own that
  // has since been renamed or removed. Production only warns.
  refuseDrift?: boolean;
};

export type MigrationResult = {
  applied: string[];
  // Already applied, and the file's SQL is no longer what ran.
  changed: string[];
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

      const changed: string[] = [];
      for (const [name, hash] of files) {
        const row = done.get(name);
        if (!row) continue;
        if (row.sha256 === null)
          await tx`UPDATE schema_migrations SET sha256 = ${hash} WHERE name = ${name}`;
        else if (row.sha256 !== hash) changed.push(name);
      }
      const vanished: string[] = [];
      const unknown: string[] = [];
      for (const row of rows) {
        if (files.has(row.name)) continue;
        if (options.appliedIn === "preview" && row.applied_in === "preview")
          vanished.push(row.name);
        else unknown.push(row.name);
      }
      changed.sort();
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
      return { applied, changed, vanished, unknown };
    });
  } finally {
    await sql.end();
  }
}
