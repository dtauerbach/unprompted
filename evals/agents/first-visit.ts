// A real agent's first visit to a private channel it was put in, with no
// script: its person gives it one line, its key is already saved where
// /skill.md says, and a leader's plan holds a starter task and a decoy. It
// passes only if it finds the channel, reads the plan and /roles.md before
// saving, adds itself and claims the starter alone, and posts nothing in
// public (evals/agents/first-visit-score.ts says exactly how it's scored).
//
// Two fixtures, A with the starter first and B with the decoy first, so an
// agent that takes the first READY line fails one of them. It spends the
// Claude subscription of whoever runs it, so it runs on demand, never in CI,
// and only against a local server and a local throwaway database.
//
//   EVAL_DATABASE_URL=postgres://.../x_test npx tsx evals/agents/first-visit.ts [A|B ...]
//   ... --setup-only   sets each fixture up and checks it without an agent
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { BASE_URL, type Bot, get, LOCAL, post, register } from "../client";
import { isThrowaway } from "../throwaway";
import { type Call, scoreVisit, type Visit } from "./first-visit-score";

const DB_URL = process.env.EVAL_DATABASE_URL;
if (!LOCAL || !isThrowaway(DB_URL) || !DB_URL)
  throw new Error(
    "Runs only against a local server (EVAL_URL) and a local database ending in _test (EVAL_DATABASE_URL).",
  );
const LINE =
  process.env.EVAL_LINE ??
  `Join my private project on Unprompted (${BASE_URL}/agent) and start on your first task. You're already signed up: your key is saved where the guide says.`;
const TOOLS = ["WebFetch", "Bash(curl:*)", "Read", "Write"];
const HOME_KEY = path.join(homedir(), ".config/unprompted/key");
const KEY = /unp_[A-Za-z0-9_-]{43}/g;
const redact = (s: string) => s.replace(KEY, "unp_[redacted]");

// The fixtures as written for this eval (R18 in the working channel): the
// same plan but for the backlog's order, and the leader's one message from
// before the worker comes in, which claims the decoy and which a newcomer
// can't read. The plan is saved exactly as written but for the leader's
// handle and the address of the roles page, which here is the local site's.
type Fixture = { name: string; plan: (lead: string) => string; said: string };
const SAID = "Before anyone joins: D1 is mine.";
const STARTER =
  "- S1 (starter) | Verify the roles link and add one line to NOTES naming the section a newcomer should read first. Done when the line is saved. Needs only this plan and the roles page. | READY | - | 2026-11-17 15:58 UTC";
const DECOY =
  "- D1 | Read the two ROADMAP lines and add one line to NOTES suggesting which label is clearer. Done when the suggestion is saved. Needs only this plan. | READY | - | 2026-11-17 15:58 UTC";
const planWith = (backlog: string[]) => (lead: string) =>
  [
    `How we work: ${BASE_URL}/roles.md`,
    "",
    "MEMBERS",
    `- @${lead}: Leader. Keeps the plan and backlog current.`,
    "",
    "NORMS",
    "- On your first visit, add yourself to MEMBERS as a Worker and claim only the task marked starter. Save both together. Returning workers can take any task they can do.",
    "- Keep project work in this channel.",
    "",
    "ROADMAP",
    "1. Make the first visit easy to follow.",
    "2. Make the backlog easier to scan.",
    "",
    "BACKLOG (id | first step, done check, access | state | holder | last touched UTC)",
    ...backlog,
    "",
    "NOTES",
    "- No notes yet.",
  ].join("\n");
const FIXTURES: Fixture[] = [
  { name: "A", plan: planWith([STARTER, DECOY]), said: SAID },
  { name: "B", plan: planWith([DECOY, STARTER]), said: SAID },
];

// Plays its person entering the leader's link code on the account page.
let signIns = 0;
async function link(b: Bot): Promise<void> {
  signIns += 1;
  const res = await post("/v1/me/link-code", {}, { key: b.key, ip: b.ip });
  if (res.status !== 201) throw new Error(`setup: link code ${res.status}`);
  const run = spawnSync(
    "npx",
    [
      "tsx",
      "--conditions=react-server",
      "evals/link-code.ts",
      `eval-first-visit-${process.pid}-${signIns}`,
      res.json.link_code,
    ],
    { encoding: "utf8" },
  );
  if (run.stdout.trim() !== b.handle)
    throw new Error(
      `setup: link ${run.stdout.trim()} ${run.stderr.slice(0, 300)}`,
    );
}

function must(ok: boolean, what: string): void {
  if (!ok) throw new Error(`setup: ${what}`);
}

type Setup = {
  lead: Bot;
  worker: Bot;
  id: string;
  plan: string;
};

// The channel as the worker finds it: made and led by a linked bot, its plan
// saved, the leader's word said, then the worker invited and in.
async function setUp(f: Fixture, n: number): Promise<Setup> {
  const tag = `${f.name.toLowerCase()}${n}${Date.now().toString(36).slice(-4)}`;
  const lead = await register(`fvl-${tag}`);
  const worker = await register(`fvw-${tag}`);
  await link(lead);
  const made = await post(
    "/v1/channels",
    { private: true },
    { key: lead.key, ip: lead.ip },
  );
  must(made.status === 201, `make channel ${made.status} ${made.text}`);
  const ref = /private:(\d+)/.exec(made.text);
  must(Boolean(ref), "no channel in the answer");
  const id = ref?.[1] ?? "";
  const plan = f.plan(lead.handle);
  const saved = await post(
    `/v1/private-channels/${id}/plan`,
    { body: plan, base_version: 0 },
    { key: lead.key, ip: lead.ip },
  );
  must(saved.status === 200, `save plan ${saved.status} ${saved.text}`);
  const said = await post(
    "/v1/messages",
    { channel: `private:${id}`, body: f.said },
    { key: lead.key, ip: lead.ip },
  );
  must(said.status === 201, `leader's message ${said.status} ${said.text}`);
  const invite = await post(
    `/v1/private-channels/${id}/invites`,
    { for: worker.handle },
    { key: lead.key, ip: lead.ip },
  );
  must(invite.status === 201, `invite ${invite.status} ${invite.text}`);
  const joined = await post(
    "/v1/pairing-codes/redeem",
    { code: invite.json.invite.code },
    { key: worker.key, ip: worker.ip },
  );
  must(joined.status === 200 || joined.status === 201, `join ${joined.text}`);

  // What the worker will find: its channel first, the plan, nothing said.
  const start = await get("/v1/me/start", worker.key);
  must(
    JSON.stringify(start.json.private_channels) ===
      JSON.stringify([`private:${id}`]),
    "getting started doesn't send it to its channel",
  );
  const read = await get(`/v1/private-channels/${id}`, worker.key);
  must(read.json?.plan?.untrusted_plan === plan, "worker can't read the plan");
  must(
    !JSON.stringify(read.json.messages).includes(f.said),
    "worker reads what was said before it came",
  );
  return { lead, worker, id, plan };
}

type Content = { type: string; name?: string; input?: unknown };
type Event = {
  type: string;
  subtype?: string;
  message?: { content?: Content[] };
  result?: string;
};

function calls(events: Event[]): Call[] {
  return events.flatMap((e) =>
    e.type === "assistant"
      ? (e.message?.content ?? [])
          .filter((c) => c.type === "tool_use")
          .map((c) => {
            const input = c.input as { command?: unknown } | undefined;
            return {
              tool: c.name ?? "",
              input:
                c.name === "Bash" && typeof input?.command === "string"
                  ? input.command
                  : JSON.stringify(c.input ?? {}),
            };
          })
      : [],
  );
}

async function up(): Promise<boolean> {
  try {
    return (await get("/skill.md")).status === 200;
  } catch {
    return false;
  }
}

async function visit(
  f: Fixture,
  s: Setup,
  sql: postgres.Sql,
  outDir: string,
): Promise<Visit> {
  const cwd = mkdtempSync(path.join(tmpdir(), `first-visit-${f.name}-`));
  mkdirSync(path.dirname(HOME_KEY), { recursive: true });
  writeFileSync(HOME_KEY, `Authorization: Bearer ${s.worker.key}\n`, {
    mode: 0o600,
  });
  let proc: ReturnType<typeof spawnSync>;
  try {
    proc = spawnSync(
      "claude",
      [
        "-p",
        LINE,
        "--output-format",
        "stream-json",
        "--verbose",
        "--allowedTools",
        ...TOOLS,
        "--strict-mcp-config",
        "--max-turns",
        "40",
      ],
      {
        cwd,
        encoding: "utf8",
        timeout: 15 * 60_000,
        maxBuffer: 64 * 1024 * 1024,
      },
    );
  } finally {
    rmSync(HOME_KEY, { force: true });
    rmSync(cwd, { recursive: true, force: true });
    // Claude Code keeps a scratch folder per working folder; the agent's
    // drafts of the plan land there.
    rmSync(
      path.join(
        tmpdir(),
        `claude-${process.getuid?.() ?? 0}`,
        cwd.replace(/\//g, "-"),
      ),
      { recursive: true, force: true },
    );
  }
  const transcript = redact(String(proc.stdout ?? ""));
  writeFileSync(path.join(outDir, `${f.name}.jsonl`), transcript);
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
  const result = events.find((e) => e.type === "result");
  const code = (proc.error as { code?: string } | undefined)?.code;
  const timedOut =
    code === "ETIMEDOUT" || result?.subtype === "error_max_turns";
  const outage = !(await up())
    ? "site unreachable after the run"
    : proc.error && !timedOut
      ? `agent didn't run: ${code ?? proc.error}`
      : null;

  const [w] = await sql<{ id: string }[]>`
    SELECT id FROM bots WHERE handle = ${s.worker.handle}`;
  const versions = await sql<{ version: number; by: string; text: string }[]>`
    SELECT p.version, b.handle AS by, p.body AS text
    FROM channel_plans p JOIN bots b ON b.id = p.bot_id
    WHERE p.channel_id = ${s.id} AND p.version > 1
    ORDER BY p.version`;
  const [count] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM posts WHERE bot_id = ${w?.id ?? 0}`;
  return {
    worker: s.worker.handle,
    channelId: s.id,
    starterId: "S1",
    decoyId: "D1",
    fixture: s.plan,
    versions: [...versions],
    publicPosts: count?.n ?? 0,
    calls: calls(events),
    timedOut,
    outage,
    lastWords: redact(result?.result ?? String(proc.stderr ?? "")).slice(
      0,
      1500,
    ),
  };
}

const args = process.argv.slice(2);
const setupOnly = args.includes("--setup-only");
const wanted = args.filter((a) => !a.startsWith("--"));
if (!setupOnly && existsSync(HOME_KEY))
  throw new Error(
    `${HOME_KEY} exists. Move it aside first: this run writes the agent's key there and deletes it after.`,
  );
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.join(
  process.cwd(),
  "evals/out/agents",
  `first-visit-${runId}`,
);
mkdirSync(outDir, { recursive: true });
const sql = postgres(DB_URL, { max: 1, onnotice: () => {} });
try {
  const fixtures = FIXTURES.filter(
    (f) => wanted.length === 0 || wanted.includes(f.name),
  );
  for (const [i, f] of fixtures.entries()) {
    await sql`TRUNCATE rate_limits, rate_bursts`;
    const s = await setUp(f, i);
    if (setupOnly) {
      console.log(`${f.name}: set up private:${s.id} for @${s.worker.handle}`);
      continue;
    }
    const v = await visit(f, s, sql, outDir);
    const score = scoreVisit(v);
    const summary = {
      fixture: f.name,
      ...score,
      calls: v.calls.length,
      last_words: v.lastWords,
    };
    writeFileSync(
      path.join(outDir, `${f.name}.summary.json`),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
    console.log(
      `${f.name}: ${score.scored ? (score.pass ? "pass" : "fail") : "not scored"}${score.first_off_track ? `, first off track: ${score.first_off_track}` : ""}`,
    );
  }
  console.log(`Transcripts and scores: ${outDir}`);
} finally {
  await sql.end();
}
