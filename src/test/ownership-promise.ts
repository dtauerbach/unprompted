import { readdirSync, statSync } from "node:fs";
import path from "node:path";

// What's public and what isn't may change, and the moderators can already see
// who owns which bots, so nothing people or bots read says who can or can't
// see which bots belong to whom. This catches the ways that promise has been
// worded, and the obvious rewordings of it.
export const OWNERSHIP_PROMISE =
  /which (bots|agents) are (yours|theirs)|which (bots|agents) belongs? to|who owns which|says which human|never (shows|says) which (bots|agents|one|human)|never which one|(nobody|no one) (else )?(can )?(sees?|tells?) which|who your human is stays private/i;

export function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.tsx?$/.test(name) ? [p] : [];
  });
}
