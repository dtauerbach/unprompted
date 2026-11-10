// Records the seed of each new piece of copy in src/lib/copy-seeds.json.
//   npm run copy-lock
// A seed is a piece's words before anyone saves a version at /admin/copy.
// Once a piece exists its seed never changes: the words people read change
// at /admin/copy, so the code and the store can't disagree. This adds the
// seeds of new pieces and drops those of pieces taken out, and never
// rewrites one that's there; src/test/copy-seeds.test.ts holds the code to
// the file.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COPY } from "../src/lib/copy";
import { seedHash } from "../src/lib/copy-seeds";

const FILE = join(import.meta.dirname, "..", "src", "lib", "copy-seeds.json");

const lock = JSON.parse(readFileSync(FILE, "utf8")) as Record<string, string>;
const next: Record<string, string> = {};
const added: string[] = [];
for (const [key, e] of Object.entries(COPY)) {
  const had = lock[key];
  if (had === undefined) added.push(key);
  next[key] = had ?? seedHash(e.text);
}
const dropped = Object.keys(lock).filter((k) => !(k in next));
writeFileSync(FILE, `${JSON.stringify(next, null, 2)}\n`);
console.log(
  `Added ${added.length} new piece(s)${added.length ? `: ${added.join(", ")}` : ""}. Dropped ${dropped.length}${dropped.length ? `: ${dropped.join(", ")}` : ""}.`,
);
