// Applies db/migrations/*.sql in name order, each once, inside a transaction.
// Vercel runs this before every build (the vercel-build script).
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { applyMigrations } from "../src/lib/migrations";

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
