// One visit by one fresh bot: a Claude Code process with a clean environment
// (no runner's memory, connectors or settings), a workspace of its own that
// lasts across visits (its "memory"), and only the tools its kind of host
// would give it.
//   http       an always-on agent that speaks HTTP: a curl-like tool and a
//              sleep, both limited to the trial's local origins, files in its
//              own workspace, plus host tools. No shell: a trial bot reads
//              other bots' words, so it never gets to run commands.
//   connector  a chat assistant with the Unprompted connector, files in its
//              workspace as its app's memory, plus host tools; no HTTP tool
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { redact } from "./redact";

export type Profile = "http" | "connector";

export type Visit = {
  bot: string;
  profile: Profile;
  model: string;
  prompt: string;
  dir: string; // the bot's run directory: workspace/, host.jsonl, visits/
  base: string;
  token?: string; // connector: the app's token, from allowApp()
  hostScript: string;
  hostInbox?: string; // where the host hands the runner each entry whole
  others?: string[];
  httpAllow?: string[]; // extra origins for the http profile (a Table)
  visit: number;
  maxTurns?: number;
  timeoutMs?: number;
  resume?: string; // continue this chat session: the owner writing back
};

export type VisitResult = {
  visit: number;
  exit: number | null;
  timedOut: boolean;
  turns?: number;
  costUsd?: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: string[];
  final: string;
  ms: number;
  sessionId?: string;
  sessionCostUsd?: number; // the session's whole cost so far, as reported
};

const HERE = path.dirname(new URL(import.meta.url).pathname);

export async function runVisit(v: Visit): Promise<VisitResult> {
  const ws = path.join(v.dir, "workspace");
  const home = path.join(v.dir, ".home");
  const vdir = path.join(v.dir, "visits");
  for (const d of [ws, home, vdir]) mkdirSync(d, { recursive: true });
  const servers: Record<string, unknown> = {
    host: {
      type: "stdio",
      command: "npx",
      args: ["tsx", path.join(HERE, "host-mcp.ts")],
      env: {
        HOST_LOG: path.join(v.dir, "host.jsonl"),
        HOST_SCRIPT: v.hostScript,
        HOST_OTHERS: (v.others ?? []).join(","),
        HOST_INBOX: v.hostInbox ?? "",
        HOST_HTTP_ALLOW:
          v.profile === "http"
            ? [new URL(v.base).origin, ...(v.httpAllow ?? [])].join(",")
            : "",
        PATH: process.env.PATH ?? "",
      },
    },
  };
  if (v.profile === "connector")
    servers.unprompted = {
      type: "http",
      url: `${v.base}/mcp`,
      headers: { Authorization: `Bearer ${v.token}` },
    };
  const mcpFile = path.join(v.dir, "mcp.json");
  writeFileSync(mcpFile, JSON.stringify({ mcpServers: servers }));
  // File tools only inside the workspace and the bot's own home (where the
  // guide says to keep a key): anything else is denied in -p mode.
  const tools = ["Read", "Write", "Edit"];
  const allowed = [
    ...tools.flatMap((t) => [`${t}(./**)`, `${t}(/${home}/**)`]),
    "mcp__host",
  ];
  if (v.profile === "connector") allowed.push("mcp__unprompted");
  const args = [
    "-p",
    v.prompt,
    "--model",
    v.model,
    "--output-format",
    "stream-json",
    "--verbose",
    "--strict-mcp-config",
    "--mcp-config",
    mcpFile,
    "--tools",
    tools.join(","),
    "--allowedTools",
    ...allowed,
    "--max-turns",
    String(v.maxTurns ?? 60),
    ...(v.resume ? ["--resume", v.resume] : []),
  ];
  const env: Record<string, string> = {
    HOME: home,
    PATH: process.env.PATH ?? "",
    LANG: "C.UTF-8",
    NO_PROXY: "localhost,127.0.0.1",
    no_proxy: "localhost,127.0.0.1",
  };
  for (const k of [
    "ANTHROPIC_BASE_URL",
    "CLAUDE_SESSION_INGRESS_TOKEN_FILE",
    "HTTPS_PROXY",
    "NODE_EXTRA_CA_CERTS",
  ])
    if (process.env[k]) env[k] = process.env[k] as string;
  const started = Date.now();
  const out: string[] = [];
  let timedOut = false;
  const exit = await new Promise<number | null>((resolve) => {
    const child = spawn("claude", args, {
      cwd: ws,
      env: env as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (b) => out.push(b.toString()));
    child.stderr.on("data", (b) =>
      out.push(JSON.stringify({ type: "stderr", text: b.toString() }) + "\n"),
    );
    const t = setTimeout(
      () => {
        timedOut = true;
        child.kill("SIGTERM");
      },
      v.timeoutMs ?? 25 * 60_000,
    );
    child.on("close", (code) => {
      clearTimeout(t);
      resolve(code);
    });
  });
  const raw = out.join("");
  // The visit's log is for people: no key, token or code in it. The
  // connector's config holds the app's token and is written afresh each
  // visit, so it goes too.
  writeFileSync(path.join(vdir, `${v.visit}.jsonl`), redact(raw));
  rmSync(mcpFile, { force: true });
  return summarize(raw, v.visit, exit, timedOut, Date.now() - started);
}

// biome-ignore lint/suspicious/noExplicitAny: stream-json events are loose
type Ev = any;
export function summarize(
  raw: string,
  visit: number,
  exit: number | null,
  timedOut: boolean,
  ms: number,
): VisitResult {
  const evs: Ev[] = raw.split("\n").flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
  const toolCalls: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  for (const e of evs) {
    if (e.type !== "assistant") continue;
    const u = e.message?.usage ?? {};
    inputTokens +=
      (u.input_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0);
    outputTokens += u.output_tokens ?? 0;
    for (const c of e.message?.content ?? [])
      if (c.type === "tool_use")
        toolCalls.push(
          `${c.name} ${redact(JSON.stringify(c.input)).slice(0, 200)}`,
        );
  }
  const result = evs.find((e) => e.type === "result");
  const init = evs.find((e) => e.type === "system" && e.subtype === "init");
  return {
    visit,
    exit,
    timedOut,
    turns: result?.num_turns,
    costUsd: result?.total_cost_usd,
    inputTokens,
    outputTokens,
    toolCalls,
    // Redacted before it is cut down, so no secret straddles the cut.
    final: redact(String(result?.result ?? "")).slice(0, 4000),
    ms,
    sessionId: result?.session_id ?? init?.session_id,
    sessionCostUsd: result?.total_cost_usd,
  };
}

export function hostLog(dir: string): Ev[] {
  try {
    return readFileSync(path.join(dir, "host.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
