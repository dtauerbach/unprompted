// Copies a finished run into a folder that may leave the machine (a CI
// artifact, a commit): only the logs people read, each through redact.ts,
// and each also cleared of every literal secret the run knew (the bots' saved
// keys, and the values of the variables named in STORY_SECRET_VARS). The
// bots' saved keys (.home), continued chats (.sessions, which hold tool
// results whole) and the connector's config never go. A bot's workspace
// notes go, redacted, since they're its memory and the judge may need them.
// It fails if a literal secret still shows anywhere it wrote.
//   npx tsx evals/stories/export.ts <run dir> <out dir>
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { redact } from "./redact";

const [src = "", out = ""] = process.argv.slice(2);
if (!src || !out) {
  console.error("usage: export.ts <run dir> <out dir>");
  process.exit(1);
}

const secrets = new Set<string>();
for (const name of (process.env.STORY_SECRET_VARS ?? "").split(",")) {
  const v = name && process.env[name];
  if (v && v.length >= 8) secrets.add(v);
}
const bots = readdirSync(src).filter((d) =>
  statSync(path.join(src, d)).isDirectory(),
);
for (const b of bots) {
  const key = path.join(src, b, ".home", ".config", "unprompted", "key");
  if (!existsSync(key)) continue;
  const m = readFileSync(key, "utf8").match(/Bearer\s+(\S+)/);
  if (m?.[1] && m[1].length >= 8) secrets.add(m[1]);
}

const clean = (t: string) => {
  let s = redact(t);
  for (const x of secrets) s = s.split(x).join("[secret]");
  return s;
};

const files: string[] = ["results.json", "server.log", "transcript.md"];
const walk = (rel: string) => {
  const abs = path.join(src, rel);
  if (!existsSync(abs)) return;
  for (const f of readdirSync(abs)) {
    const r = path.join(rel, f);
    if (statSync(path.join(src, r)).isDirectory()) walk(r);
    else if (statSync(path.join(src, r)).size < 5_000_000) files.push(r);
  }
};
for (const b of bots) {
  files.push(path.join(b, "host.jsonl"), path.join(b, "owner.json"));
  walk(path.join(b, "visits"));
  walk(path.join(b, "workspace"));
}

let n = 0;
for (const r of files) {
  const from = path.join(src, r);
  if (!existsSync(from)) continue;
  const to = path.join(out, r);
  mkdirSync(path.dirname(to), { recursive: true });
  const t = clean(readFileSync(from, "utf8"));
  for (const x of secrets)
    if (t.includes(x)) throw new Error(`a secret survived in ${r}`);
  writeFileSync(to, t);
  n++;
}
console.log(`exported ${n} files, ${secrets.size} literal secrets cleared`);
