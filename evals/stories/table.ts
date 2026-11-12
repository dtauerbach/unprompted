// The dinner Table (dtauerbach/unprompted-tables, tables/dinner) run beside a
// story's site, the way evals/run-local.ts in that repo runs it: its own _test
// database, its own bot on the story's site, its own port. Build it first.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { redactedSink } from "./redact";
import type { Site } from "./site";

const TABLE_DIR =
  process.env.DINNER_DIR ?? "/home/user/unprompted-tables/tables/dinner";
const PG =
  process.env.STORIES_PG ?? "postgres://postgres:postgres@localhost:5432";

export type Table = { base: string; stop: () => void };

export async function startDinner(
  site: Site,
  port: number,
  outDir: string,
  variant?: string,
): Promise<Table> {
  const db = `story_dinner_${port}_test`;
  const admin = postgres(`${PG}/postgres`, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${db}`);
  } finally {
    await admin.end();
  }
  const reg = await fetch(`${site.base}/v1/bots`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": "10.250.0.1" },
    body: JSON.stringify({ handle: "dinner-table" }),
  });
  const { api_key } = (await reg.json()) as { api_key: string };
  const base = `http://localhost:${port}`;
  const env = {
    ...process.env,
    DATABASE_URL: `${PG}/${db}`,
    DATABASE_URL_UNPOOLED: `${PG}/${db}`,
    PORT: String(port),
    UNPROMPTED_URL: site.base,
    UNPROMPTED_KEY: api_key,
    UNPROMPTED_BOT: "dinner-table",
    IP_HASH_SECRET: "stories-table-local-only",
    TABLE_URL: base,
    NEXT_TELEMETRY_DISABLED: "1",
    ...(variant ? { DINNER_VARIANT: variant } : {}),
  };
  const m = spawnSync("npm", ["run", "migrate"], {
    cwd: TABLE_DIR,
    env,
    encoding: "utf8",
  });
  if (m.status !== 0) throw new Error(`table migrate: ${m.stderr}${m.stdout}`);
  // Redacted as it streams in: a log people read.
  const logFile = path.join(outDir, "table.log");
  const child: ChildProcess = spawn("npm", ["start"], {
    cwd: TABLE_DIR,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  redactedSink((t) => appendFileSync(logFile, t), [child.stdout, child.stderr]);
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${base}/v1`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return {
    base,
    stop: () => {
      if (child.pid)
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {}
    },
  };
}
