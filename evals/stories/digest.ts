// Turns a finished run directory into transcript.md: per bot, each visit's
// prompt, tool calls with short answers, and its final words; then the
// owner touches, the posts made during the run and the cost. The judge reads
// this instead of raw stream-json.
//   npx tsx evals/stories/digest.ts <run dir>
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { redact } from "./redact";

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
  ...(res.setup_touches?.length
    ? [
        `Before the clock started, the owner: ${res.setup_touches.map((t: Any) => `${t.kind}${t.bot ? ` ${t.bot}` : ""}${t.detail ? ` (${t.detail})` : ""}`).join("; ")}.`,
        "",
      ]
    : []),
];
// Secrets come out before a line is cut, so a cut can't leave a piece of one
// too short for the pass over the whole transcript at the end to know.
const clip = (raw: string, n: number) => {
  const s = redact(raw);
  return s.length > n ? `${s.slice(0, n)} [...${s.length - n} more]` : s;
};
// Minutes on the story's clock, which starts once the cast is in place.
const setupMin: number =
  res.events.find((e: Any) => e.setup === "done")?.min ?? 0;
const t1 = new Date(res.started).getTime() + setupMin * 60_000;
const storyMin = (at: string | number | Date) =>
  +((new Date(at).getTime() - t1) / 60_000).toFixed(1);
const m = (at: string | number | Date) => `m${storyMin(at)}`;

for (const b of res.bots) {
  out.push(
    `## Bot ${b.name} (${b.owner}'s, ${b.profile}, ${b.model})`,
    "",
    `Owner line: ${b.line || "(none)"}`,
    ...(b.host ? ["", `Its app (how it is woken): ${b.host}`] : []),
    ...(b.wake
      ? ["", `Its app starts it on a wake with: ${b.wake.prompt}`]
      : []),
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
        `- ${h.at.slice(11, 19)} (${m(h.at)}) ${h.kind} ${clip(JSON.stringify({ ...h, at: undefined, kind: undefined }), 400)}`,
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
    `- #${p.id} ${where} @${p.handle} ${String(p.created_at).slice(11, 19)} (${m(p.created_at)}): ${clip(String(p.body).replace(/\n+/g, " / "), 400)}`,
  );
}
if (res.messages?.length) {
  out.push("", "## Private messages during the run", "");
  for (const x of res.messages)
    out.push(
      `- #${x.id} @${x.from_handle} -> ${x.to_handle ? `@${x.to_handle}` : x.channel} (${m(x.created_at)}): ${clip(String(x.body).replace(/\n+/g, " / "), 400)}`,
    );
}
if (res.presence?.length) {
  out.push("", "## Presence set during the run", "");
  for (const x of res.presence)
    out.push(
      `- @${x.from_handle} -> @${x.to_handle} (${m(x.created_at)}): ${x.state}, next_check ${x.next_check ? m(x.next_check) : "none"}, note ${JSON.stringify(x.note ?? "")}`,
    );
}

// When each bot was running, on the story's clock, and the gaps between.
out.push("", "## Visits timeline (story minutes)", "");
for (const b of res.bots) {
  const starts = res.events.filter((e: Any) => e.bot === b.name && e.prompt);
  const ends = res.events.filter((e: Any) => e.bot === b.name && e.done);
  const spans = starts.map((s: Any) => {
    const e = ends.find((x: Any) => x.visit === s.visit);
    return {
      visit: s.visit,
      from: +(s.min - setupMin).toFixed(1),
      to: e ? +(e.min - setupMin).toFixed(1) : res.minutes,
      lane: e?.lane ?? "?",
      causes: s.causes,
    };
  });
  out.push(`- ${b.name}:`);
  for (const s of spans)
    out.push(
      `  - visit ${s.visit} m${s.from} to m${s.to} (${s.lane}; ${s.causes.join(", ")})`,
    );
  // Gaps of more than 30 minutes with nothing running, from the bot's first
  // start to the story's end.
  const sorted = [...spans].sort((a, c) => a.from - c.from);
  let reach = sorted[0]?.from ?? 0;
  const gaps: string[] = [];
  for (const s of sorted) {
    if (s.from - reach > 30) gaps.push(`m${reach} to m${s.from}`);
    reach = Math.max(reach, s.to);
  }
  if (res.minutes - reach > 30) gaps.push(`m${reach} to m${res.minutes}`);
  out.push(`  - gaps over 30 min: ${gaps.length ? gaps.join("; ") : "none"}`);
  for (const h of b.host ?? [])
    if (h.kind === "schedule_visit_granted")
      out.push(
        `  - asked at ${m(h.at)} for a visit at m${(storyMin(h.at) + h.in_minutes).toFixed(1)}: ${clip(JSON.stringify(h.note), 200)}`,
      );
}

if (res.story === "s5") story5Facts();

// The facts the s5 rubric asks for that are tedious to count by hand.
function story5Facts() {
  const c = res.collected ?? {};
  const team: string[] = (c.team ?? []).map((t: Any) => t.name);
  const subjects: string[] = (res.subjects ?? []).map((s: Any) => s.handle);
  out.push("", "## Story 5 facts", "");
  // Which handle each bot signed up with, read from its own calls.
  for (const name of team) {
    const asked = new Set<string>();
    const vdir = path.join(dir, name, "visits");
    let files: string[] = [];
    try {
      files = readdirSync(vdir);
    } catch {}
    for (const f of files)
      for (const l of readFileSync(path.join(vdir, f), "utf8").split("\n")) {
        let e: Any;
        try {
          e = JSON.parse(l);
        } catch {
          continue;
        }
        if (e.type !== "assistant") continue;
        for (const x of e.message?.content ?? []) {
          if (x.type !== "tool_use") continue;
          if (String(x.name).endsWith("sign_up") && x.input?.handle)
            asked.add(String(x.input.handle));
          if (
            String(x.name).endsWith("http_request") &&
            /\/v1\/bots\/?$/.test(String(x.input?.url ?? "")) &&
            x.input?.method === "POST"
          ) {
            try {
              const h = JSON.parse(String(x.input.body ?? "{}")).handle;
              if (h) asked.add(String(h));
            } catch {}
          }
        }
      }
    // A taken handle gets a number added.
    const got = subjects.filter((s) =>
      [...asked].some(
        (a) => s === a || (s.startsWith(a) && /^\d+$/.test(s.slice(a.length))),
      ),
    );
    out.push(
      `- ${name} asked for ${[...asked].join(", ") || "no handle"}; site has ${got.join(", ") || "none of them"}`,
    );
  }
  const own = res.posts.filter((p: Any) => subjects.includes(p.handle));
  const threads = own.filter((p: Any) => !p.parent_id);
  out.push(
    `- threads started by the team: ${threads.length} (${threads.map((p: Any) => `#${p.id} [${p.slug}] "${p.title ?? ""}" by @${p.handle} at ${m(p.created_at)}`).join("; ") || "none"})`,
  );
  // Posts by each subject in half-hour buckets: did work go on after the
  // first hour?
  for (const h of subjects) {
    const buckets = [0, 0, 0, 0];
    for (const p of own)
      if (p.handle === h) {
        const i = Math.min(
          3,
          Math.max(0, Math.floor(storyMin(p.created_at) / 30)),
        );
        buckets[i] = (buckets[i] ?? 0) + 1;
      }
    out.push(
      `- @${h} posts by half hour (0-30, 30-60, 60-90, 90+): ${buckets.join(", ")}`,
    );
  }
  const psa = c.psa?.post;
  out.push(
    `- news: ${psa?.id ? `#${psa.id} at ${m(psa.at)}` : `not posted (${JSON.stringify(psa)})`}`,
  );
  const words: string[] = c.psa_keywords ?? [];
  const took = [
    ...own,
    ...(res.messages ?? []).map((x: Any) => ({ ...x, handle: x.from_handle })),
  ].filter((p: Any) =>
    words.some(
      (w) => String(p.body).includes(w) || String(p.title ?? "").includes(w),
    ),
  );
  out.push(
    `- team posts or messages naming the news (${words.join(", ")}): ${took.length ? took.map((p: Any) => `@${p.handle} at ${m(p.created_at)}`).join("; ") : "none"}`,
  );
  // Owner touches, per bot and in all. The scripted end-of-story prod isn't
  // one. Whether a visit the bot booked counts depends on the arm (see
  // rubric.md); both are listed.
  const setupTouches: Any[] = res.setup_touches ?? [];
  let total = setupTouches.length;
  for (const b of res.bots) {
    const host = b.host ?? [];
    const k = (kind: string) => host.filter((h: Any) => h.kind === kind);
    const prodAt = t1 + 115 * 60_000;
    const early = k("tell_owner").filter(
      (h: Any) => new Date(h.at).getTime() < prodAt,
    );
    const lines = b.line ? 1 : 0;
    total += lines + k("ask_owner").length + early.length;
    const causes = res.events
      .filter((e: Any) => e.bot === b.name && e.causes)
      .flatMap((e: Any) => e.causes);
    const n = (c: string) => causes.filter((x: string) => x === c).length;
    out.push(
      `- ${b.name} owner touches: line ${lines}, ask_owner ${k("ask_owner").length}, tell_owner before the prod ${early.length}, visits booked ${k("schedule_visit_granted").length}, refused ${k("schedule_visit_refused").length}; started by: owner line ${n("owner line")}, booked visit ${n("scheduled")}, wake ${n("wake")}, prod ${n("owner prod")}`,
    );
  }
  out.push(
    `- owner touches in all, not counting booked visits or the prod: ${total} (setup ${setupTouches.length}: ${setupTouches.map((t: Any) => `${t.kind}${t.bot ? ` ${t.bot}` : ""}`).join(", ") || "none"})`,
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
writeFileSync(path.join(dir, "transcript.md"), redact(out.join("\n")));
console.log(path.join(dir, "transcript.md"));
