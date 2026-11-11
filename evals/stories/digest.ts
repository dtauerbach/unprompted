// Turns a finished run directory into transcript.md: per bot, each visit's
// prompt, tool calls with short answers, and its final words; then the
// owner touches, the posts made during the run and the cost. The judge reads
// this instead of raw stream-json.
//   npx tsx evals/stories/digest.ts <run dir>
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// biome-ignore lint/suspicious/noExplicitAny: loose JSON
type Any = any;
const dir = process.argv[2] ?? "";
const res: Any = JSON.parse(
  readFileSync(path.join(dir, "results.json"), "utf8"),
);
const out: string[] = [
  `# ${res.story} (${res.arm}): ${res.title}`,
  `Started ${res.started}, ${res.minutes} minutes.`,
  "",
];
const clip = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n)} [...${s.length - n} more]` : s;

for (const b of res.bots) {
  out.push(
    `## Bot ${b.name} (${b.owner}'s, ${b.profile}, ${b.model})`,
    "",
    `Owner line: ${b.line}`,
    "",
  );
  const vdir = path.join(dir, b.name, "visits");
  let files: string[] = [];
  try {
    files = readdirSync(vdir).sort(
      (a, c) => Number.parseInt(a) - Number.parseInt(c),
    );
  } catch {}
  const prompts = res.events.filter((e: Any) => e.bot === b.name && e.prompt);
  for (const f of files) {
    const n = Number.parseInt(f);
    const p = prompts.find((e: Any) => e.visit === n);
    out.push(
      `### Visit ${n} at minute ${p?.min ?? "?"} (${(p?.causes ?? []).join(", ")})`,
      "",
    );
    if (p && n > 1) out.push(`Prompt: ${clip(p.prompt, 300)}`, "");
    for (const l of readFileSync(path.join(vdir, f), "utf8").split("\n")) {
      let e: Any;
      try {
        e = JSON.parse(l);
      } catch {
        continue;
      }
      if (e.type === "assistant")
        for (const c of e.message?.content ?? []) {
          if (c.type === "tool_use")
            out.push(
              `- CALL ${c.name.replace("mcp__", "")} ${clip(JSON.stringify(c.input), 600)}`,
            );
          if (c.type === "text" && c.text.trim())
            out.push(
              `- SAYS ${clip(c.text.trim().replace(/\n+/g, " / "), 800)}`,
            );
        }
      if (e.type === "user")
        for (const c of e.message?.content ?? []) {
          if (c?.type !== "tool_result") continue;
          const t =
            typeof c.content === "string"
              ? c.content
              : (c.content ?? []).map((x: Any) => x.text ?? "").join(" ");
          out.push(`  - got ${clip(t.replace(/\s+/g, " "), 500)}`);
        }
      if (e.type === "result")
        out.push("", `FINAL: ${clip(String(e.result ?? ""), 2500)}`, "");
    }
  }
  out.push("Owner touches and host calls:");
  for (const h of b.host ?? [])
    if (!["http", "wait"].includes(h.kind))
      out.push(
        `- ${h.at.slice(11, 19)} ${h.kind} ${clip(JSON.stringify({ ...h, at: undefined, kind: undefined }), 400)}`,
      );
  const waits = (b.host ?? []).filter((h: Any) => h.kind === "wait");
  const http = (b.host ?? []).filter((h: Any) => h.kind === "http").length;
  out.push(
    `- waits: ${waits.length}, ${waits.reduce((s: number, h: Any) => s + h.seconds, 0)} s; http calls: ${http}`,
  );
  const tokens = (b.visits ?? []).reduce(
    (s: number, v: Any) => s + v.inputTokens,
    0,
  );
  out.push(
    `- cost $${b.costUsd.toFixed(3)}; visits ${b.visits?.length}; tokens in ${tokens}`,
    "",
  );
}
out.push("## Posts during the run", "");
for (const p of res.posts) {
  const where = p.parent_id
    ? `re #${p.parent_id}`
    : `[${p.slug}] "${p.title ?? ""}"`;
  out.push(
    `- #${p.id} ${where} @${p.handle} ${String(p.created_at).slice(11, 19)}: ${clip(String(p.body).replace(/\n+/g, " / "), 400)}`,
  );
}
out.push(
  "",
  "## Subjects (bots not in the cast)",
  "",
  "```",
  JSON.stringify(res.subjects),
  "```",
  "",
  "## Site actions by bot",
  "",
  "```",
  JSON.stringify(res.actions),
  "```",
);
if (res.collected)
  out.push(
    "",
    "## Scenario facts",
    "",
    "```",
    clip(JSON.stringify(res.collected), 4000),
    "```",
  );
writeFileSync(path.join(dir, "transcript.md"), out.join("\n"));
console.log(path.join(dir, "transcript.md"));
