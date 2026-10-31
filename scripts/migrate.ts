// Applies db/migrations/*.sql in name order, each once, all in one
// transaction. So a migration file must not use anything that can't run inside
// a transaction (CREATE INDEX CONCURRENTLY, VACUUM), and must not use an enum
// value that an earlier file in the same deploy adds.
// Then it pins the house account's welcome post, with the norms in it, and
// starts a thread for each new open question: content/welcome.md,
// content/norms.md and content/questions.md, or an admin's newer version of
// any of them (src/lib/bot-texts.ts).
// Vercel runs this before every build (the vercel-build script).
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";
import { syncHouseTexts } from "../src/lib/bot-texts";
import { applyMigrations } from "../src/lib/migrations";

const onVercel = Boolean(process.env.VERCEL);
const env = process.env.VERCEL_ENV;

if (onVercel && !process.env.IP_HASH_SECRET) {
  console.error(
    "IP_HASH_SECRET is not set. In Vercel, add it under Settings > Environment Variables as a long random string, for all environments.",
  );
  process.exit(1);
}

// A preview build runs an unmerged branch's SQL. Unless each preview has its
// own Neon branch (then set MIGRATE_PREVIEWS=1), that SQL would hit the
// production database before review, so previews skip migrations.
if (onVercel && env !== "production" && process.env.MIGRATE_PREVIEWS !== "1") {
  console.log(`Skipping migrations on a ${env ?? "non-production"} build.`);
  process.exit(0);
}

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) {
  console.error(
    "DATABASE_URL is not set. On Vercel, add a Neon database under Storage and connect it to this project.",
  );
  process.exit(1);
}

const dir = path.join(process.cwd(), "db/migrations");
const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
const migrations = await Promise.all(
  files.map(async (name) => ({
    name,
    sql: await readFile(path.join(dir, name), "utf8"),
  })),
);

const applied = await applyMigrations(url, migrations);
console.log(
  applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date.",
);

const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
try {
  for (const r of await syncHouseTexts(sql)) {
    if (r.skipped) continue;
    if (r.key === "welcome")
      console.log(
        r.posted.length
          ? `Pinned welcome post ${r.posted.join(", ")}.`
          : "Welcome post is up to date.",
      );
    else
      console.log(
        r.posted.length
          ? `Asked ${r.posted.length} open questions: ${r.posted.join(", ")}.`
          : "Open questions are up to date.",
      );
  }
} finally {
  await sql.end();
}
