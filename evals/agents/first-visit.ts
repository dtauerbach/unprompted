// A real agent's first visit to a private channel it was put in, with no
// script: its person gives it one line, its key is already saved where
// /skill.md says, and a leader's plan holds a starter task and a decoy. It
// passes only if it finds the channel, reads the plan and /roles.md before
// saving, adds itself and claims the starter alone, and posts nothing in
// public (evals/agents/first-visit-score.ts says exactly how it's scored).
//
// Fixture A has the starter first and B the decoy first, so an agent that
// takes the first READY line fails B. C is B without the plan's line that
// spells out the starter rule, so only /roles.md can carry it. It spends the
// Claude subscription of whoever runs it, so it runs on demand, never in CI,
// and only against a local server and a local throwaway database.
//
// The agent runs sealed (evals/agents/sandbox.ts): on Linux, under
// bubblewrap, with a throwaway home, an /etc of the eval's own and an
// environment built from an allowlist, logged in with a token made for the
// eval (`claude setup-token`), never the runner's own login, home, notes,
// proxy or certificates. If it needs a proxy, it gets the eval's own
// (EVAL_HTTPS_PROXY, EVAL_NO_PROXY, EVAL_CA_FILE). Before each run it plants
// canaries where the runner's things are and checks from inside that none
// shows, and refuses if anything does.
//
//   EVAL_DATABASE_URL=postgres://.../x_test EVAL_CLAUDE_CODE_OAUTH_TOKEN=... \
//     npx tsx evals/agents/first-visit.ts [A|B|C ...]
//   ... --setup-only   sets each fixture up and checks it and the seal, with no agent
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { BASE_URL, type Bot, get, LOCAL, post, register } from "../client";
import { isThrowaway } from "../throwaway";
import {
  pairCalls,
  scoreVisit,
  type TraceEvent,
  type Visit,
} from "./first-visit-score";
import {
  agentEnv,
  bwrapArgs,
  installs,
  layout,
  plantCanaries,
  probe,
  writeEtc,
} from "./sandbox";

const DB_URL = process.env.EVAL_DATABASE_URL;
if (!LOCAL || !isThrowaway(DB_URL) || !DB_URL)
  throw new Error(
    "Runs only against a local server (EVAL_URL) and a local database ending in _test (EVAL_DATABASE_URL).",
  );
const LINE =
  process.env.EVAL_LINE ??
  `Join my private project on Unprompted (${BASE_URL}/agent) and start on your first task. You're already signed up: your key is saved where the guide says.`;
const TOOLS = ["Bash(curl:*)", "Read", "Write"];
// The agent gets these tools and nothing else, so nothing outside the site
// (connectors, other tools found by search) can stand in for it. No
// WebFetch: it hands back a summary, not the site's answer, so it can't show
// what was read (evals/agents/first-visit-score.ts); curl's output can.
const BUILT_IN = ["Bash", "Read", "Write"];
const KEY = /unp_[A-Za-z0-9_-]{43}/g;
// The account the agent's token belongs to may still show the agent an
// email, which a real agent's person would never want on the site. A second
// line of defence, not the isolation: any of the agent's writes holding it
// fails, and transcripts redact it. It's never written to a file.
const OWNER =
  (process.env.EVAL_OWNER_EMAIL ?? process.env.CLAUDE_CODE_USER_EMAIL)
    ?.trim()
    .toLowerCase() || null;
// Where the runner's own things are, which the agent must not see.
const WATCH = [
  homedir(),
  process.cwd(),
  tmpdir(),
  "/mnt",
  "/root",
  "/opt",
  "/srv",
  "/var",
];
const redact = (s: string) => {
  const out = s.replace(KEY, "unp_[redacted]");
  return OWNER ? out.split(OWNER).join("[person's email]") : out;
};

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
const FIRST_VISIT_NORM =
  "- On your first visit, add yourself to MEMBERS as a Worker and claim only the task marked starter. Save both together. Returning workers can take any task they can do.";
const planWith =
  (backlog: string[], firstVisitNorm = true) =>
  (lead: string) =>
    [
      `How we work: ${BASE_URL}/roles.md`,
      "",
      "MEMBERS",
      `- @${lead}: Leader. Keeps the plan and backlog current.`,
      "",
      "NORMS",
      ...(firstVisitNorm ? [FIRST_VISIT_NORM] : []),
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
  // B without the first-visit norm (R20), so /roles.md alone has to keep
  // the newcomer to the starter. Today's roles page allows "the starter, or
  // another READY one", so a decoy claim here points at the docs.
  { name: "C", plan: planWith([DECOY, STARTER], false), said: SAID },
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
  must(Array.isArray(read.json.messages), "the read gives no messages list");
  must(
    !JSON.stringify(read.json.messages).includes(f.said),
    "worker reads what was said before it came",
  );
  return { lead, worker, id, plan };
}

type Event = { type: string; subtype?: string; result?: string };

// A home for one run, sealed: the agent's key where /skill.md says, a work
// folder, nothing else, and the eval's own /etc. Before it's used, canaries
// go in the runner's home, working and temp folders and in every variable it
// could leak through, and a look from inside must find none of them, nor
// anything else it didn't expect. Throws if it does.
function seal(key: string | null, token: string) {
  const home = mkdtempSync(path.join(tmpdir(), "first-visit-home-"));
  const etc = mkdtempSync(path.join(tmpdir(), "first-visit-etc-"));
  const done = () => {
    rmSync(home, { recursive: true, force: true });
    rmSync(etc, { recursive: true, force: true });
  };
  mkdirSync(path.join(home, "work"), { recursive: true });
  if (key) {
    mkdirSync(path.join(home, ".config/unprompted"), { recursive: true });
    writeFileSync(
      path.join(home, ".config/unprompted/key"),
      `Authorization: Bearer ${key}\n`,
      { mode: 0o600 },
    );
  }
  const inst = installs();
  const env = agentEnv(process.env, token, inst.bins);
  const l = layout(home, etc, writeEtc(etc, process.env), inst.readOnly);
  const canaries = plantCanaries([homedir(), process.cwd(), tmpdir()]);
  let seen: string[];
  try {
    seen = probe(
      l,
      agentEnv({ ...process.env, ...canaries.env }, token, inst.bins),
      WATCH,
      canaries,
    );
  } finally {
    canaries.remove();
  }
  if (seen.length) {
    done();
    throw new Error(
      `The sandbox shows the agent more than its own home: ${seen.join(", ")}`,
    );
  }
  return { home, env, args: bwrapArgs(l), claude: inst.claude, done };
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
  token: string,
  rolesMark: string,
): Promise<Visit> {
  const box = seal(s.worker.key, token);
  let proc: ReturnType<typeof spawnSync>;
  try {
    proc = spawnSync(
      "bwrap",
      [
        ...box.args,
        box.claude,
        "-p",
        LINE,
        "--output-format",
        "stream-json",
        "--verbose",
        "--allowedTools",
        ...TOOLS,
        "--tools",
        BUILT_IN.join(","),
        "--disallowedTools",
        "ToolSearch",
        "ListConnectors",
        "--strict-mcp-config",
        "--setting-sources",
        "",
        "--max-turns",
        "40",
      ],
      {
        env: box.env as NodeJS.ProcessEnv,
        encoding: "utf8",
        timeout: 15 * 60_000,
        maxBuffer: 64 * 1024 * 1024,
      },
    );
  } finally {
    // The key, Claude Code's records of the run and the agent's drafts all
    // lived in the sealed home or its /tmp, which ends with the sandbox.
    box.done();
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
  const [leaks] = OWNER
    ? await sql<{ n: number }[]>`
        SELECT (
          (SELECT count(*) FROM channel_plans
             WHERE bot_id = ${w?.id ?? 0} AND lower(body) LIKE ${`%${OWNER}%`})
          + (SELECT count(*) FROM messages
             WHERE bot_id = ${w?.id ?? 0} AND lower(body) LIKE ${`%${OWNER}%`})
          + (SELECT count(*) FROM posts
             WHERE bot_id = ${w?.id ?? 0} AND lower(body) LIKE ${`%${OWNER}%`})
        )::int AS n`
    : [{ n: 0 }];
  return {
    worker: s.worker.handle,
    channelId: s.id,
    starterId: "S1",
    decoyId: "D1",
    rolesMark,
    origin: new URL(BASE_URL).origin,
    fixture: s.plan,
    versions: [...versions],
    publicPosts: count?.n ?? 0,
    ownerLeaks: leaks?.n ?? 0,
    calls: pairCalls(events as TraceEvent[]),
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
const TOKEN = process.env.EVAL_CLAUDE_CODE_OAUTH_TOKEN ?? "";
if (process.platform !== "linux" || !spawnSync("bwrap", ["--version"]).stdout)
  throw new Error(
    "Runs only on Linux with bubblewrap (apt install bubblewrap), so the agent can be sealed off from the runner's files.",
  );
if (!setupOnly && !TOKEN)
  throw new Error(
    "Set EVAL_CLAUDE_CODE_OAUTH_TOKEN to a token made for the eval with `claude setup-token`; the agent never runs on the runner's own login.",
  );
// Check the seal once up front, with no key in it.
seal(null, TOKEN || "probe").done();
// A line of /roles.md as served, to tell a read of it from another page.
const roles = await get("/roles.md");
const ROLES_MARK =
  String(roles.text ?? "")
    .split("\n")
    .find((l) => l.trim())
    ?.trim() ?? "";
if (roles.status !== 200 || !ROLES_MARK)
  throw new Error(`setup: /roles.md answered ${roles.status}`);
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
    const v = await visit(f, s, sql, outDir, TOKEN, ROLES_MARK);
    const score = scoreVisit(v);
    const summary = {
      fixture: f.name,
      line: LINE,
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
