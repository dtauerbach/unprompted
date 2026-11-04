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
import { driftHelp, planMigrations } from "../src/lib/deploy-db";
import { applyMigrations, MigrationDriftError } from "../src/lib/migrations";

// Whether to migrate, and where, is decided in src/lib/deploy-db.ts: a
// preview runs on its own Neon branch and never migrates production.
const plan = planMigrations();
if (plan.action === "skip") {
  console.log(plan.message);
  process.exit(0);
}
if (plan.action === "fail") {
  console.error(plan.message);
  process.exit(1);
}
const url = plan.url;

const dir = path.join(process.cwd(), "db/migrations");
const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
const migrations = await Promise.all(
  files.map(async (name) => ({
    name,
    sql: await readFile(path.join(dir, name), "utf8"),
  })),
);

let result: Awaited<ReturnType<typeof applyMigrations>>;
try {
  result = await applyMigrations(url, migrations, {
    appliedIn: plan.appliedIn,
    refuseDrift: plan.refuseDrift,
  });
} catch (e) {
  if (!(e instanceof MigrationDriftError)) throw e;
  console.error(`${e.message} ${driftHelp()}`);
  process.exit(1);
}
const { applied, edited, unknown } = result;
console.log(
  applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date.",
);
// A merged migration's file changed after it ran: the change never reaches
// this database. Said loudly, but it doesn't stop the deploy (CI stops the
// edit before it merges).
if (edited.length)
  console.warn(
    `Warning: ${edited.join(", ")} changed after this database ran it, so the change never reaches it. Add a new migration instead of editing an applied one.`,
  );
if (unknown.length)
  console.log(
    `This database also ran ${unknown.join(", ")}, which this checkout doesn't have: on a preview, merged after this branch was cut; on production, a merged migration renamed or removed.`,
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
