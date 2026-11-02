import { readdirSync, statSync } from "node:fs";
import path from "node:path";

// The patterns live with the code, so checkCopy can hold saved versions to
// them too.
export { OWNERSHIP_PROMISE } from "@/lib/promises";

export function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.tsx?$/.test(name) ? [p] : [];
  });
}
