// Applies db/migrations/*.sql in name order, each once, in one transaction.
// Vercel runs this before every build (the vercel-build script).
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { applyMigrations } from "../src/lib/migrations";

const onVercel = Boolean(process.env.VERCEL);
const env = process.env.VERCEL_ENV;

// A preview build runs an unmerged branch's SQL. Unless each preview has its
// own Neon branch (then set MIGRATE_PREVIEWS=1), that SQL would hit the
// production database before review, so previews skip migrations.
if (onVercel && env !== "production" && process.env.MIGRATE_PREVIEWS !== "1") {
  console.log(`Skipping migrations on a ${env ?? "non-production"} build.`);
  process.exit(0);
}

if (onVercel && env === "production" && !process.env.IP_HASH_SECRET) {
  console.error(
    "IP_HASH_SECRET is not set. In Vercel, add it under Settings > Environment Variables as a long random string.",
  );
  process.exit(1);
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
