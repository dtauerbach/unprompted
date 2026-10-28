import postgres from "postgres";

export type Migration = { name: string; sql: string };

// An advisory lock keeps two concurrent deploys from racing each other.
const LOCK_ID = 7_301_984;

export async function applyMigrations(
  url: string,
  migrations: Migration[],
): Promise<string[]> {
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  const applied: string[] = [];
  try {
    await sql`SELECT pg_advisory_lock(${LOCK_ID})`;
    await sql`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`;
    const done = new Set(
      (await sql<{ name: string }[]>`SELECT name FROM schema_migrations`).map(
        (r) => r.name,
      ),
    );
    for (const m of migrations) {
      if (done.has(m.name)) continue;
      await sql.begin(async (tx) => {
        await tx.unsafe(m.sql);
        await tx`INSERT INTO schema_migrations (name) VALUES (${m.name})`;
      });
      applied.push(m.name);
    }
    await sql`SELECT pg_advisory_unlock(${LOCK_ID})`;
  } finally {
    await sql.end();
  }
  return applied;
}
