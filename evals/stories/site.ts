// A throwaway copy of the site for one story run: its own database, cloned
// from a migrated template, and its own server on its own port. Local only:
// every database here ends in _test (evals/throwaway.ts).
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { openSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { isThrowaway } from "../throwaway";

const PG =
  process.env.STORIES_PG ?? "postgres://postgres:postgres@localhost:5432";
// The template is named for the migrations it was built from, so a checkout
// with new or changed migrations builds its own instead of reusing a stale one.
function templateName(): string {
  const dir = path.resolve("db/migrations");
  const h = createHash("sha256");
  for (const f of readdirSync(dir).sort())
    h.update(f).update(readFileSync(path.join(dir, f)));
  return `stories_tpl_${h.digest("hex").slice(0, 10)}_test`;
}
export const TEMPLATE = templateName();

function dbUrl(name: string): string {
  const url = `${PG}/${name}`;
  if (!isThrowaway(url))
    throw new Error(`${url} is not a local _test database`);
  return url;
}

// Generous limits: every trial bot comes from 127.0.0.1, so the per-address
// sign-up cap would otherwise stop the second bot. Everything else keeps the
// repo's defaults, so new bots stay new and gates stay as they ship.
const TRIAL_LIMITS = {
  register_per_ip: 1000,
  register_global: 100000,
  register_tightened: 100000,
  spike_sign_ups: 100000,
  approve_per_ip: 100000,
  client_per_ip: 100000,
};

// Builds the template once: migrate, then loosen the sign-up caps.
export async function ensureTemplate(): Promise<void> {
  const admin = postgres(`${PG}/postgres`, { max: 1, onnotice: () => {} });
  try {
    const [row] =
      await admin`SELECT 1 FROM pg_database WHERE datname = ${TEMPLATE}`;
    if (row) return;
    await admin.unsafe(`CREATE DATABASE ${TEMPLATE}`);
  } finally {
    await admin.end();
  }
  const url = dbUrl(TEMPLATE);
  const r = spawnSync(
    "npx",
    ["tsx", "--conditions=react-server", "scripts/migrate.ts"],
    {
      env: { ...process.env, DATABASE_URL: url, DATABASE_URL_UNPOOLED: url },
      encoding: "utf8",
    },
  );
  if (r.status !== 0) throw new Error(`migrate failed: ${r.stderr}${r.stdout}`);
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const { ANTI_ABUSE_DEFAULTS } = await import("../../src/lib/settings");
    const limits = { ...ANTI_ABUSE_DEFAULTS, ...TRIAL_LIMITS };
    await sql`INSERT INTO settings (key, value) VALUES ('anti_abuse_limits', ${sql.json(limits)})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  } finally {
    await sql.end();
  }
}

export type Site = {
  base: string;
  db: string;
  sql: postgres.Sql;
  stop: () => Promise<void>;
};

async function waitUp(base: string, ms = 60_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${base}/v1/channels`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`site at ${base} didn't come up`);
}

// Starts a copy of the built site (run `npx next build` first) on `port`,
// against a fresh clone of the template.
export async function startSite(opts: {
  name: string;
  port: number;
  outDir: string;
  env?: Record<string, string>;
}): Promise<Site> {
  await ensureTemplate();
  const db = `story_${opts.name.replace(/[^a-z0-9]/g, "_")}_test`;
  const admin = postgres(`${PG}/postgres`, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${db} TEMPLATE ${TEMPLATE}`);
  } finally {
    await admin.end();
  }
  const url = dbUrl(db);
  const log = openSync(path.join(opts.outDir, "server.log"), "a");
  const child: ChildProcess = spawn(
    "npx",
    ["next", "start", "-p", String(opts.port)],
    {
      env: {
        ...process.env,
        DATABASE_URL: url,
        DATABASE_URL_UNPOOLED: url,
        IP_HASH_SECRET: "stories-local-only-secret-0123456789abcdef",
        UNPROMPTED_READ_ONLY: "0",
        ...opts.env,
      },
      stdio: ["ignore", log, log],
      detached: true,
    },
  );
  const base = `http://localhost:${opts.port}`;
  await waitUp(base);
  const sql = postgres(url, { max: 4, onnotice: () => {} });
  return {
    base,
    db: url,
    sql,
    stop: async () => {
      await sql.end();
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {}
      }
    },
  };
}
