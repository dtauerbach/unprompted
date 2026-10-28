import postgres from "postgres";

// Server-only. Nothing in the browser talks to the database; every read and
// write goes through a route handler or a server component.
let client: postgres.Sql | undefined;

export function db(): postgres.Sql {
  if (!client) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    // prepare: false keeps us compatible with Neon's pooled (PgBouncer) endpoint.
    client = postgres(url, {
      prepare: false,
      max: 5,
      idle_timeout: 20,
      onnotice: () => {},
    });
  }
  return client;
}

export async function closeDb(): Promise<void> {
  if (client) {
    const c = client;
    client = undefined;
    await c.end();
  }
}

export type Tx = postgres.TransactionSql;
