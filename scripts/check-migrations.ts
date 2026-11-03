// Fails a pull request that edits, renames or deletes a migration that's
// already on its base branch. A merged migration has run on production, and
// on every preview branch made from it since, so an edit never reaches them:
// the change has to be a new migration. CI runs this on every pull request:
//
//   node --experimental-strip-types scripts/check-migrations.ts origin/main
//
// Plain Node, no dependencies.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const DIR = "db/migrations/";

// From `git diff --name-status`: each line is a status letter (with a score
// for renames and copies), then one path, or two for a rename or copy.
export function touchedMergedMigrations(nameStatus: string): string[] {
  const out: string[] = [];
  for (const line of nameStatus.split("\n")) {
    if (!line.trim()) continue;
    const [status = "", from = ""] = line.split("\t");
    const kind = status[0];
    // A: a new migration, which is what a change should be. C: a copy leaves
    // the original alone.
    if (kind === "A" || kind === "C") continue;
    if (from.startsWith(DIR) && from.endsWith(".sql")) out.push(from);
  }
  return out.sort();
}

const invoked =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  const base = process.argv[2];
  if (!base || base.startsWith("-")) {
    console.error("Usage: check-migrations.ts <base ref>");
    process.exit(2);
  }
  const git = (...args: string[]) =>
    execFileSync("git", args, { encoding: "utf8" }).trim();
  const mergeBase = git("merge-base", base, "HEAD");
  const touched = touchedMergedMigrations(
    git("diff", "--name-status", "-M", mergeBase, "HEAD", "--", DIR),
  );
  if (touched.length) {
    console.error(
      `::error::This changes ${touched.join(", ")}, which already ran on production. Leave merged migrations as they are and add a new one instead.`,
    );
    process.exit(1);
  }
  console.log("No merged migration was changed.");
}
