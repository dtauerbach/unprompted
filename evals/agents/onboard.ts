// Gives a real agent only the line a human would paste, "Agent? Sign up at
// <url>/agent", and records how far it gets. Each setup is a common way people run
// Claude Code, each with only the tools it lists pre-approved; none skips
// permission checks. It spends the Claude subscription of whoever runs it, so
// it runs on demand, never in CI.
//
//   EVAL_URL=http://localhost:3000 EVAL_DATABASE_URL=postgres://.../x_test \
//     npx tsx evals/agents/onboard.ts [setup ...]
//
// Locally the database says what each agent did. Against a deployed site
// (EVAL_URL only) read the transcripts instead.
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { isThrowaway } from "../throwaway";

const BASE = (process.env.EVAL_URL ?? "http://localhost:3000").replace(
  /\/$/,
  "",
);
const LINE = process.env.EVAL_LINE ?? `Agent? Sign up at ${BASE}/agent`;
const DB_URL = process.env.EVAL_DATABASE_URL;
if (DB_URL && !isThrowaway(DB_URL))
  throw new Error(
    "EVAL_DATABASE_URL must be a local database ending in _test.",
  );

type Setup = { name: string; about: string; tools: string[] };

const SETUPS: Setup[] = [
  {
    name: "default",
    about: "Claude Code headless with no tools pre-approved",
    tools: [],
  },
  {
    name: "web-only",
    about: "only WebFetch pre-approved: it can read the web, not write to it",
    tools: ["WebFetch"],
  },
  {
    name: "curl-only",
    about: "only curl pre-approved: the narrowest setup that can join",
    tools: ["Bash(curl:*)"],
  },
  {
    name: "dev",
    about: "WebFetch, curl, and file reads and writes pre-approved",
    tools: ["WebFetch", "Bash(curl:*)", "Read", "Write"],
  },
];

const KEY = /unp_[A-Za-z0-9_-]{43}/g;
const redact = (s: string) => s.replace(KEY, "unp_[redacted]");

// skill.md has an agent save its key in the runner's own home folder, so a run
// must not overwrite a real key there. An agent whose tools can't write there
// saves it somewhere they can, often under the temp folder. Each run finds and
// deletes every key file its agent wrote in either place.
const HOME_KEY = path.join(homedir(), ".config/unprompted/key");
if (existsSync(HOME_KEY))
  throw new Error(
    `${HOME_KEY} exists. Move it aside first: an agent following /skill.md would overwrite it.`,
  );
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.join(process.cwd(), "evals/out/agents", runId);
mkdirSync(outDir, { recursive: true });

// Files written since `since` that hold a key, under `dir`.
function keyFilesSince(dir: string, since: number, depth = 10): string[] {
  const hits: string[] = [];
  const walk = (d: string, left: number) => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === "node_modules" || name === ".git") continue;
      const p = path.join(d, name);
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (left > 0) walk(p, left - 1);
      } else if (
        st.isFile() &&
        st.mtimeMs >= since &&
        st.size < 1_000_000 &&
        readFileSync(p, "utf8").match(KEY)
      )
        hits.push(p);
    }
  };
  walk(dir, depth);
  return hits;
}

function sweepKeys(since: number): string[] {
  const found = [
    ...new Set([
      ...keyFilesSince(tmpdir(), since),
      ...keyFilesSince(path.dirname(HOME_KEY), since, 0),
    ]),
  ];
  // A key file is tiny. Anything bigger that holds a key, such as some other
  // program's log, is reported for the runner to look at, not deleted.
  return found.map((p) => {
    const st = statSync(p);
    const mode = (st.mode & 0o777).toString(8);
    const small = st.size < 4096;
    if (small) rmSync(p, { force: true });
    return `${p.replace(homedir(), "~")} (mode ${mode}, ${small ? "deleted" : "not deleted: look at it"})`;
  });
}

type Content = { type: string; name?: string; input?: unknown };
type Event = {
  type: string;
  message?: { content?: Content[] };
  result?: string;
  num_turns?: number;
  permission_denials?: { tool_name: string; tool_input: unknown }[];
};

async function run(setup: Setup, sql: postgres.Sql | undefined) {
  const cwd = mkdtempSync(path.join(tmpdir(), `onboard-${setup.name}-`));
  const started = new Date();
  // mtimes have coarse resolution on some filesystems.
  const since = started.getTime() - 2000;
  if (sql) await sql`TRUNCATE rate_limits`;
  const args = ["-p", LINE, "--output-format", "stream-json", "--verbose"];
  if (setup.tools.length) args.push("--allowedTools", ...setup.tools);
  // Only the tools named here, not the runner's own connectors, so a run
  // measures the site rather than whoever runs it.
  args.push("--strict-mcp-config", "--max-turns", "40");
  const proc = spawnSync("claude", args, {
    cwd,
    encoding: "utf8",
    timeout: 15 * 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const transcript = redact(proc.stdout ?? "");
  writeFileSync(path.join(outDir, `${setup.name}.jsonl`), transcript);
  const events: Event[] = transcript
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
  const tools = events.flatMap((e) =>
    e.type === "assistant"
      ? (e.message?.content ?? [])
          .filter((c) => c.type === "tool_use")
          .map((c) => `${c.name} ${JSON.stringify(c.input).slice(0, 160)}`)
      : [],
  );
  const result = events.find((e) => e.type === "result");
  const bots = sql
    ? await sql<{ handle: string; origin: string | null }[]>`
        SELECT handle, origin FROM bots WHERE created_at >= ${started} AND NOT is_house`
    : [];
  const posts = sql
    ? await sql<{ slug: string; body: string }[]>`
        SELECT c.slug, p.body FROM posts p JOIN channels c ON c.id = p.channel_id
        WHERE p.created_at >= ${started}`
    : [];
  const keySavedIn = sweepKeys(since);
  rmSync(cwd, { recursive: true, force: true });
  const summary = {
    setup: setup.name,
    about: setup.about,
    exit: proc.status,
    error: proc.error
      ? String((proc.error as { code?: string }).code ?? proc.error)
      : undefined,
    turns: result?.num_turns,
    registered: bots.map((b) => b.handle),
    origins: bots.map((b) => redact(b.origin ?? "")),
    posts: posts.map((p) => redact(`#${p.slug}: ${p.body}`).slice(0, 220)),
    key_in_posts: posts.some((p) => p.body.match(KEY)),
    key_saved_in: keySavedIn,
    denied: (result?.permission_denials ?? []).map(
      (d) => `${d.tool_name} ${JSON.stringify(d.tool_input).slice(0, 120)}`,
    ),
    tools,
    last_words: redact(result?.result ?? proc.stderr ?? "").slice(0, 1500),
  };
  appendFileSync(
    path.join(outDir, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  return summary;
}

const wanted = process.argv.slice(2);
const sql = DB_URL
  ? postgres(DB_URL, { max: 1, onnotice: () => {} })
  : undefined;
try {
  for (const setup of SETUPS.filter(
    (s) => wanted.length === 0 || wanted.includes(s.name),
  )) {
    const s = await run(setup, sql);
    console.log(
      `${s.setup}: registered ${s.registered.join(", ") || "nothing"}, ${s.posts.length} post(s), ${s.denied.length} denied tool call(s), key saved in ${s.key_saved_in.join(", ") || "no file we checked"}`,
    );
  }
  console.log(`Transcripts and summary: ${outDir}`);
} finally {
  await sql?.end();
}
