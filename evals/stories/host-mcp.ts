// The bot's host, as a tiny MCP server over stdio: the few things any
// assistant app gives a bot besides the site. Every call is logged to
// $HOST_LOG as JSON lines, which is how the harness counts owner touches.
// That log is for people, so it's redacted (redact.ts); the runner gets each
// entry whole at $HOST_INBOX (inbox.ts), since a message passed between
// owners may carry a code the other bot needs.
//   ask_owner     a question to the person; answered from the scenario's
//                 script (the owner is busy and never volunteers anything)
//   tell_owner    a message to the person; with pass_to, the person passes
//                 it to another owner they're with (one relay)
//   schedule_visit  asks the person's app to bring the bot back later
//   http_request, wait  only for an always-on agent (the "http" profile):
//                 curl and sleep, limited to the trial's own local origins,
//                 so a trial bot never runs commands or reaches anything else
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { type HostEntry, tellRunner } from "./inbox";
import { redact } from "./redact";

const LOG = process.env.HOST_LOG ?? "/dev/null";
const SCRIPT = process.env.HOST_SCRIPT ?? "";
const ALLOW = (process.env.HOST_HTTP_ALLOW ?? "").split(",").filter(Boolean);
const OTHERS = (process.env.HOST_OTHERS ?? "").split(",").filter(Boolean);
const INBOX = process.env.HOST_INBOX || undefined;

type Script = { answer: string; visits_allowed: number };
function script(): Script {
  const s =
    SCRIPT && existsSync(SCRIPT)
      ? JSON.parse(readFileSync(SCRIPT, "utf8"))
      : {};
  return { answer: "I'm busy, use your judgment.", visits_allowed: 1, ...s };
}
async function log(e: { kind: string } & Record<string, unknown>) {
  const entry: HostEntry = { at: new Date().toISOString(), ...e };
  appendFileSync(LOG, `${redact(JSON.stringify(entry))}\n`);
  await tellRunner(INBOX, entry);
}
function count(kind: string): number {
  if (!existsSync(LOG)) return 0;
  return readFileSync(LOG, "utf8")
    .split("\n")
    .filter((l) => l.includes(`"kind":"${kind}"`)).length;
}
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

const server = new McpServer({ name: "host", version: "1" });

server.registerTool(
  "ask_owner",
  {
    description: "Ask the person you work for a question. They may be busy.",
    inputSchema: { question: z.string() },
  },
  async ({ question }) => {
    const { answer } = script();
    await log({ kind: "ask_owner", question, answer });
    return text(answer);
  },
);

server.registerTool(
  "tell_owner",
  {
    description:
      OTHERS.length > 0
        ? `Send the person you work for a message. If they should pass it on to someone they're with, set pass_to to one of: ${OTHERS.join(", ")}.`
        : "Send the person you work for a message.",
    inputSchema: OTHERS.length
      ? { message: z.string(), pass_to: z.string().optional() }
      : { message: z.string() },
  },
  async (args: Record<string, unknown>) => {
    const { message } = args as { message: string };
    const passTo = (args as { pass_to?: string }).pass_to;
    if (passTo && !OTHERS.includes(passTo)) {
      await log({
        kind: "tell_owner",
        message,
        pass_to: passTo,
        delivered: false,
      });
      return text(`Your person doesn't know who "${passTo}" is.`);
    }
    await log({
      kind: "tell_owner",
      message,
      pass_to: passTo ?? null,
      delivered: !!passTo,
    });
    return text(
      passTo ? `Your person passed it to ${passTo}.` : "Your person got it.",
    );
  },
);

server.registerTool(
  "schedule_visit",
  {
    description:
      "Ask your person's app to start you again later. Give minutes from now and a note to yourself.",
    inputSchema: {
      in_minutes: z
        .number()
        .min(1)
        .max(24 * 60),
      note: z.string(),
    },
  },
  async ({ in_minutes, note }) => {
    const granted = count("schedule_visit_granted") < script().visits_allowed;
    await log({
      kind: granted ? "schedule_visit_granted" : "schedule_visit_refused",
      in_minutes,
      note,
    });
    return text(
      granted
        ? `Scheduled: you'll be started again in about ${in_minutes} minutes with your note.`
        : "Your person didn't set that up: no more scheduled visits for now.",
    );
  },
);

if (ALLOW.length > 0) {
  server.registerTool(
    "http_request",
    {
      description:
        "Make an HTTP request, like curl. Returns the status, the content type and the body.",
      inputSchema: {
        method: z
          .enum(["GET", "POST", "PUT", "PATCH", "DELETE"])
          .default("GET"),
        url: z.string(),
        headers: z.record(z.string(), z.string()).optional(),
        body: z.string().optional(),
      },
    },
    async ({ method, url, headers, body }) => {
      let origin = "";
      try {
        origin = new URL(url).origin;
      } catch {}
      if (!ALLOW.includes(origin)) {
        await log({ kind: "http_refused", url });
        return text(`error: can't reach ${url} from here`);
      }
      try {
        const r = await fetch(url, {
          method,
          headers,
          body,
          redirect: "manual",
        });
        const t = await r.text();
        await log({ kind: "http", method, url, status: r.status });
        return text(
          `HTTP ${r.status}\ncontent-type: ${r.headers.get("content-type") ?? ""}${
            r.headers.get("location")
              ? `\nlocation: ${r.headers.get("location")}`
              : ""
          }${r.headers.get("retry-after") ? `\nretry-after: ${r.headers.get("retry-after")}` : ""}\n\n${t.slice(0, 40_000)}`,
        );
      } catch (e) {
        return text(`error: ${String(e)}`);
      }
    },
  );
  server.registerTool(
    "wait",
    {
      description:
        "Sleep for some seconds (at most 300), like the shell's sleep.",
      inputSchema: { seconds: z.number().min(1).max(300) },
    },
    async ({ seconds }) => {
      await log({ kind: "wait", seconds });
      await new Promise((r) => setTimeout(r, seconds * 1000));
      return text(`slept ${seconds}s`);
    },
  );
}

await server.connect(new StdioServerTransport());
