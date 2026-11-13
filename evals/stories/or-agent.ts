// One visit by one fresh bot on any OpenRouter model: the same tools a
// Claude Code bot gets in agent.ts (the host's tools, the Unprompted
// connector or the trial's own http_request and wait, and Read, Write and
// Edit inside its workspace), driven by a plain tool-calling loop over
// OpenRouter's chat completions. Nothing else: no shell, no web.
//
// It writes each visit as the same stream-json lines a Claude Code visit
// does (system init, assistant, user tool_result, result), so digest.ts and
// summarize() read both alike. A chat that continues (the owner writing
// back) keeps its messages in <bot>/.sessions/, which is no log: it holds
// tool results whole, so it never leaves the machine.
//
// Spend: every call's cost (OpenRouter's usage.cost) adds to one count for
// the whole process; past STORY_BUDGET_USD every visit stops before its next
// call. The key's own limit on OpenRouter is the ceiling above that.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { summarize, type Visit, type VisitResult } from "./agent";
import { redact } from "./redact";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const API = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
const BUDGET = Number(process.env.STORY_BUDGET_USD ?? "30");
// A tool's answer the model sees, at most: about what Claude Code lets an
// MCP answer through.
const RESULT_CAP = 24_000;

let spent = 0;
export const orSpent = () => spent;
export const orOverBudget = () => spent >= BUDGET;

// biome-ignore lint/suspicious/noExplicitAny: OpenAI-shaped JSON is loose
type Any = any;
type Tool = {
  name: string; // as the model sees it
  description: string;
  parameters: Any;
  call: (args: Any) => Promise<string>;
};

const text = (r: Any): string =>
  (r?.content ?? [])
    .map((c: Any) => (c.type === "text" ? c.text : JSON.stringify(c)))
    .join("\n");

// JSON Schema as MCP gives it, trimmed of what some providers refuse.
function schema(s: Any): Any {
  if (!s || typeof s !== "object") return { type: "object", properties: {} };
  const { $schema: _s, ...rest } = s;
  return { type: "object", properties: {}, ...rest };
}

async function mcpTools(prefix: string, client: Client): Promise<Tool[]> {
  const { tools } = await client.listTools();
  return tools.map((t) => ({
    name: `mcp__${prefix}__${t.name}`,
    description: t.description ?? "",
    parameters: schema(t.inputSchema),
    call: async (args) => {
      const r = await client.callTool({ name: t.name, arguments: args });
      return `${r.isError ? "Error: " : ""}${text(r)}`;
    },
  }));
}

// Read, Write and Edit, only inside the workspace and the bot's own home.
function fileTools(ws: string, home: string): Tool[] {
  const inside = (p: string) => {
    const abs = path.resolve(ws, p);
    for (const root of [ws, home])
      if (abs === root || abs.startsWith(`${root}${path.sep}`)) return abs;
    throw new Error(`${p} is outside the folders you may use`);
  };
  return [
    {
      name: "Read",
      description:
        "Read a file in your workspace. Returns its lines, numbered.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string" },
          offset: { type: "number", description: "First line, from 1" },
          limit: { type: "number" },
        },
        required: ["file_path"],
      },
      call: async ({ file_path, offset, limit }) => {
        const lines = readFileSync(inside(file_path), "utf8").split("\n");
        const from = Math.max(1, Number(offset) || 1);
        const to = limit ? from + Number(limit) - 1 : lines.length;
        return lines
          .slice(from - 1, to)
          .map((l, i) => `${from + i}\t${l}`)
          .join("\n");
      },
    },
    {
      name: "Write",
      description: "Write a file in your workspace, replacing it if it exists.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string" },
          content: { type: "string" },
        },
        required: ["file_path", "content"],
      },
      call: async ({ file_path, content }) => {
        const abs = inside(file_path);
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, String(content ?? ""));
        return `Wrote ${abs}`;
      },
    },
    {
      name: "Edit",
      description:
        "Replace old_string with new_string in a file in your workspace. old_string must appear exactly once unless replace_all is true.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
          replace_all: { type: "boolean" },
        },
        required: ["file_path", "old_string", "new_string"],
      },
      call: async ({ file_path, old_string, new_string, replace_all }) => {
        const abs = inside(file_path);
        const t = readFileSync(abs, "utf8");
        const n = t.split(String(old_string)).length - 1;
        if (n === 0) throw new Error("old_string isn't in the file");
        if (n > 1 && !replace_all)
          throw new Error(`old_string appears ${n} times; give more context`);
        writeFileSync(
          abs,
          replace_all
            ? t.split(String(old_string)).join(String(new_string))
            : t.replace(String(old_string), () => String(new_string)),
        );
        return `Edited ${abs}`;
      },
    },
  ];
}

// The few lines any agent app puts before a chat: who it is, the time, where
// its files are, and its app's standing instructions (as Claude Code reads
// CLAUDE.md from its folder).
function systemPrompt(ws: string, home: string): string {
  const about = existsSync(path.join(ws, "CLAUDE.md"))
    ? readFileSync(path.join(ws, "CLAUDE.md"), "utf8")
    : "";
  return [
    "You are an AI agent running in your person's app. You act only through your tools; your last message in a run is what your person's app shows them.",
    `The time now is ${new Date().toISOString()}.`,
    `Your working folder is ${ws}. Read, Write and Edit work there and in ${home}; those files are all you keep from one run to the next.`,
    about ? `Your app's standing instructions:\n${about}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

type Session = { messages: Any[]; costUsd: number };

const INSTRUCTIONS_HEAD = "# Connector instructions";

// The server's instructions from its MCP handshake, under the server's name,
// the way Claude Code lists them; empty if it sent none.
export function connectorInstructions(
  site: Pick<Client, "getInstructions">,
): string {
  const said = site.getInstructions()?.trim();
  return said ? `\n\n${INSTRUCTIONS_HEAD}\n\n## Unprompted\n${said}` : "";
}

// Anthropic's models cache a prompt only where it's marked, unlike OpenAI's
// and Google's, which cache on their own. Marked on the system prompt and the
// newest message, as Claude Code does. If OpenRouter refuses the marks, the
// run carries on without them.
let cacheMarks = true;
export const orCacheMarks = () => cacheMarks;
const mark = (m: Any): Any => ({
  ...m,
  content: (typeof m.content === "string"
    ? [{ type: "text", text: m.content || " " }]
    : m.content
  ).map((c: Any, i: number, all: Any[]) =>
    i === all.length - 1 ? { ...c, cache_control: { type: "ephemeral" } } : c,
  ),
});
function withMarks(model: string, messages: Any[]): Any[] {
  if (!cacheMarks || !model.startsWith("anthropic/")) return messages;
  return messages.map((m, i) =>
    (i === 0 && m.role === "system") || (i === messages.length - 1 && m.content)
      ? mark(m)
      : m,
  );
}

async function complete(
  model: string,
  history: Any[],
  tools: Tool[],
  deadline: number,
): Promise<Any> {
  let last = "";
  for (let i = 0; i < 5; i++) {
    const messages = withMarks(model, history);
    const left = deadline - Date.now();
    if (left <= 0) throw new Error("timed out");
    try {
      const r = await fetch(`${API}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${process.env.OPENROUTER_API_KEY ?? ""}`,
          "content-type": "application/json",
          "x-title": "unprompted story trials",
        },
        body: JSON.stringify({
          model,
          messages,
          tools: tools.map((t) => ({
            type: "function",
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            },
          })),
          tool_choice: "auto",
          max_tokens: 16_000,
          usage: { include: true },
        }),
        signal: AbortSignal.timeout(Math.min(left, 10 * 60_000)),
      });
      const t = await r.text();
      if (r.status === 429 || r.status >= 500) {
        last = `${r.status} ${t.slice(0, 300)}`;
        await new Promise((s) => setTimeout(s, 5_000 * 2 ** i));
        continue;
      }
      const j = JSON.parse(t);
      if (r.status === 400 && cacheMarks && messages !== history) {
        cacheMarks = false;
        last = `400 with cache marks: ${t.slice(0, 300)}`;
        continue;
      }
      if (!r.ok || j.error)
        throw new Error(
          `${r.status} ${JSON.stringify(j.error ?? j).slice(0, 500)}`,
        );
      if (!j.choices?.[0]?.message) {
        last = `no message: ${t.slice(0, 300)}`;
        await new Promise((s) => setTimeout(s, 5_000 * 2 ** i));
        continue;
      }
      return j;
    } catch (e) {
      last = String(e);
      if (/^Error: [45]\d\d /.test(last) && !/^Error: 429/.test(last)) throw e;
      await new Promise((s) => setTimeout(s, 5_000 * 2 ** i));
    }
  }
  throw new Error(`OpenRouter kept failing: ${last}`);
}

export async function runOrVisit(v: Visit): Promise<VisitResult> {
  const ws = path.join(v.dir, "workspace");
  const home = path.join(v.dir, ".home");
  const vdir = path.join(v.dir, "visits");
  const sdir = path.join(v.dir, ".sessions");
  for (const d of [ws, home, vdir, sdir]) mkdirSync(d, { recursive: true });
  const started = Date.now();
  const deadline = started + (v.timeoutMs ?? 25 * 60_000);
  const lines: string[] = [];
  const emit = (e: Any) => lines.push(JSON.stringify(e));

  const sessionId = v.resume ?? randomUUID();
  const sfile = path.join(sdir, `${sessionId}.json`);
  const session: Session =
    v.resume && existsSync(sfile)
      ? JSON.parse(readFileSync(sfile, "utf8"))
      : {
          messages: [{ role: "system", content: systemPrompt(ws, home) }],
          costUsd: 0,
        };
  session.messages.push({ role: "user", content: v.prompt });
  emit({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    model: v.model,
  });

  const clients: Client[] = [];
  let turns = 0;
  let final = "";
  let exit: number | null = 0;
  let timedOut = false;
  try {
    const host = new Client({ name: "story-app", version: "1" });
    await host.connect(
      new StdioClientTransport({
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
        stderr: "ignore",
      }),
    );
    clients.push(host);
    const tools: Tool[] = [
      ...fileTools(ws, home),
      ...(await mcpTools("host", host)),
    ];
    if (v.profile === "connector") {
      const site = new Client({ name: "story-app", version: "1" });
      await site.connect(
        new StreamableHTTPClientTransport(new URL(`${v.base}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${v.token}` } },
        }),
      );
      clients.push(site);
      tools.push(...(await mcpTools("unprompted", site)));
      // A chat app puts a connector's own instructions in the system prompt
      // beside its tools, as Claude Code and the Claude apps do. Added once
      // per chat, by content, so a chat whose first visit failed before
      // this point, or one saved before it, still gets them.
      const sys = session.messages[0];
      if (
        sys?.role === "system" &&
        !String(sys.content).includes(INSTRUCTIONS_HEAD)
      )
        sys.content += connectorInstructions(site);
    }
    const byName = new Map(tools.map((t) => [t.name, t]));
    const maxTurns = v.maxTurns ?? 60;
    while (turns < maxTurns) {
      if (orOverBudget()) {
        final ||= "(stopped: the trial's budget is spent)";
        exit = 2;
        break;
      }
      if (Date.now() >= deadline) {
        timedOut = true;
        break;
      }
      const j = await complete(v.model, session.messages, tools, deadline);
      turns++;
      const msg = j.choices[0].message;
      const cost = Number(j.usage?.cost ?? 0) || 0;
      spent += cost;
      session.costUsd += cost;
      // Kept whole, reasoning included: some providers need their own
      // reasoning back on the next turn of a tool call.
      session.messages.push({
        role: "assistant",
        content: msg.content ?? "",
        ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}),
        ...(msg.reasoning_details
          ? { reasoning_details: msg.reasoning_details }
          : {}),
      });
      const calls: Any[] = msg.tool_calls ?? [];
      const said = typeof msg.content === "string" ? msg.content : "";
      emit({
        type: "assistant",
        message: {
          model: j.model,
          content: [
            ...(said.trim() ? [{ type: "text", text: said }] : []),
            ...calls.map((c) => {
              let input: Any = {};
              try {
                input = JSON.parse(c.function?.arguments || "{}");
              } catch {
                input = { unparsed: c.function?.arguments };
              }
              return {
                type: "tool_use",
                id: c.id,
                name: c.function?.name,
                input,
              };
            }),
          ],
          usage: {
            input_tokens: j.usage?.prompt_tokens ?? 0,
            output_tokens: j.usage?.completion_tokens ?? 0,
          },
          cost_usd: cost,
        },
      });
      if (said.trim()) final = said;
      if (!calls.length) break;
      const results: Any[] = [];
      for (const c of calls) {
        let out: string;
        try {
          const t = byName.get(c.function?.name);
          if (!t) throw new Error(`no tool named ${c.function?.name}`);
          const args = JSON.parse(c.function?.arguments || "{}");
          out = await t.call(args);
        } catch (e) {
          out = `Error: ${(e as Error).message}`;
        }
        if (out.length > RESULT_CAP)
          out = `${out.slice(0, RESULT_CAP)}\n[cut: ${out.length - RESULT_CAP} more characters]`;
        session.messages.push({
          role: "tool",
          tool_call_id: c.id,
          content: out,
        });
        results.push({ type: "tool_result", tool_use_id: c.id, content: out });
      }
      emit({ type: "user", message: { content: results } });
    }
  } catch (e) {
    exit = 1;
    final ||= `(the visit ended on an error: ${(e as Error).message})`;
    emit({ type: "stderr", text: String(e) });
  } finally {
    for (const c of clients) await c.close().catch(() => {});
  }
  writeFileSync(sfile, JSON.stringify(session));
  emit({
    type: "result",
    num_turns: turns,
    total_cost_usd: session.costUsd,
    result: final,
    session_id: sessionId,
  });
  const raw = `${lines.join("\n")}\n`;
  writeFileSync(path.join(vdir, `${v.visit}.jsonl`), redact(raw));
  return summarize(raw, v.visit, exit, timedOut, Date.now() - started);
}
