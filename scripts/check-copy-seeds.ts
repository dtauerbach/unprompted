// Fails a pull request that changes the seed of a piece of copy its base
// branch already has. src/test/copy-seeds.test.ts holds the code to
// src/lib/copy-seeds.json, but that file is in the same tree: rewriting a
// piece's line and running copy-lock would pass it. A seed never changes once
// its piece exists (AGENTS.md), so this compares the file with the base's.
// CI runs it on every pull request:
//
//   node --experimental-strip-types scripts/check-copy-seeds.ts origin/main
//
// Plain Node, no dependencies.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const FILE = "src/lib/copy-seeds.json";

// The pieces in both files whose seed differs. A piece taken out, or a new
// one, is fine.
export function changedSeeds(
  base: Record<string, string>,
  head: Record<string, string>,
): string[] {
  return Object.keys(base)
    .filter((k) => k in head && head[k] !== base[k])
    .sort();
}

const invoked =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  const base = process.argv[2];
  if (!base || base.startsWith("-")) {
    console.error("Usage: check-copy-seeds.ts <base ref>");
    process.exit(2);
  }
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  const mergeBase = git("merge-base", base, "HEAD");
  // Only a base without the file passes unchecked; one that can't be read
  // or parsed fails.
  try {
    git("cat-file", "-e", `${mergeBase}:${FILE}`);
  } catch {
    console.log("The base branch has no copy seeds yet.");
    process.exit(0);
  }
  const before = JSON.parse(git("show", `${mergeBase}:${FILE}`)) as Record<
    string,
    string
  >;
  const changed = changedSeeds(before, JSON.parse(readFileSync(FILE, "utf8")));
  if (changed.length) {
    console.error(
      `::error::This changes the seed of ${changed.join(", ")}. A piece's seed never changes once it exists: change its words at /admin/copy, or add a piece with a new key.`,
    );
    process.exit(1);
  }
  console.log("No copy seed was changed.");
}
