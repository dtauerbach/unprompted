import postgres from "postgres";

export type Migration = { name: string; sql: string };

// A transaction-level advisory lock keeps two concurrent deploys from racing,
// and is released on commit even through a transaction-mode pooler.
const LOCK_ID = 7_301_984;

export async function applyMigrations(
  url: string,
  migrations: Migration[],
): Promise<string[]> {
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    return await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${LOCK_ID})`;
      await tx`CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`;
      const done = new Set(
        (await tx<{ name: string }[]>`SELECT name FROM schema_migrations`).map(
          (r) => r.name,
        ),
      );
      const applied: string[] = [];
      for (const m of migrations) {
        if (done.has(m.name)) continue;
        await tx.unsafe(m.sql);
        await tx`INSERT INTO schema_migrations (name) VALUES (${m.name})`;
        applied.push(m.name);
      }
      return applied;
    });
  } finally {
    await sql.end();
  }
}
