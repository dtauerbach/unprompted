import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// docs/MODEL.md is the one map of the site's nouns and connector tools. These
// tests keep it true: a tool added to the connector without a row, a row for a
// tool that no longer exists, or a merge into a tool the model doesn't plan,
// fails here rather than drifting into another pile of primitives.

const root = process.cwd();
const NOUNS = new Set(["Person", "Bot", "Channel", "Post", "Event"]);
const TARGET_SURFACE_MAX = 25;

export type Row = { tool: string; noun: string; fate: string };

export function registeredTools(source: string): string[] {
  const names = [
    ...source.matchAll(/registerTool\(\s*(["'`])([^"'`]+)\1/g),
  ].map((m) => m[2] ?? "");
  const calls = source.match(/registerTool\(/g)?.length ?? 0;
  if (names.length !== calls) {
    throw new Error(
      `registerTool is called ${calls} times but only ${names.length} have a literal name`,
    );
  }
  return names;
}

export function toolMap(model: string): Row[] {
  const start = model.indexOf("\n## Connector tools\n");
  if (start < 0)
    throw new Error("docs/MODEL.md has no Connector tools section");
  const rest = model.slice(start + 1);
  const end = rest.indexOf("\n## ", 3);
  const section = end < 0 ? rest : rest.slice(0, end);
  const rows: Row[] = [];
  for (const line of section.split("\n")) {
    if (!line.startsWith("| `")) continue;
    const m = line.match(/^\| `([a-z_]+)` \| ([A-Za-z]+) \| (.+?) \|$/);
    if (!m) throw new Error(`malformed tool map row: ${line}`);
    rows.push({ tool: m[1] ?? "", noun: m[2] ?? "", fate: m[3] ?? "" });
  }
  return rows;
}

const FATE =
  /^(keep( \(as `[a-z_]+`\))?|merge into `([a-z_]+)`|http-only|retired?|planned)$/;

export function problems(registered: string[], rows: Row[]): string[] {
  const out: string[] = [];
  const reg = new Set(registered);
  const byTool = new Map<string, Row>();
  for (const r of rows) {
    if (byTool.has(r.tool)) out.push(`${r.tool}: more than one row`);
    byTool.set(r.tool, r);
  }
  for (const t of registered) {
    if (!byTool.has(t))
      out.push(`${t}: registered in mcp.ts but missing from docs/MODEL.md`);
  }
  for (const r of rows) {
    if (!NOUNS.has(r.noun))
      out.push(`${r.tool}: "${r.noun}" is not one of the five nouns`);
    const f = r.fate.match(FATE);
    if (!f) {
      out.push(`${r.tool}: unknown fate "${r.fate}"`);
      continue;
    }
    if (r.fate === "planned" && reg.has(r.tool)) {
      out.push(`${r.tool}: built now, so its fate is no longer planned`);
    }
    // A retired tool has left the connector; its row is the record.
    if (r.fate === "retired" && reg.has(r.tool)) {
      out.push(`${r.tool}: retired, so it shouldn't be registered in mcp.ts`);
    }
    if (r.fate !== "planned" && r.fate !== "retired" && !reg.has(r.tool)) {
      out.push(`${r.tool}: has a row but isn't registered in mcp.ts`);
    }
    const into = f[3];
    if (into) {
      const target = byTool.get(into) ?? rows.find((x) => x.tool === into);
      if (!target || !/^(keep|planned)/.test(target.fate)) {
        out.push(
          `${r.tool}: merges into ${into}, which the model doesn't keep or plan`,
        );
      }
    }
  }
  const surface = rows.filter((r) => /^(keep|planned)/.test(r.fate)).length;
  if (surface > TARGET_SURFACE_MAX) {
    out.push(
      `target surface is ${surface} tools, more than ${TARGET_SURFACE_MAX}`,
    );
  }
  return out;
}

describe("docs/MODEL.md", () => {
  const model = readFileSync(path.join(root, "docs/MODEL.md"), "utf8");
  const mcp = readFileSync(path.join(root, "src/lib/mcp.ts"), "utf8");

  it("maps every connector tool, and only real or planned ones", () => {
    const registered = registeredTools(mcp);
    expect(registered.length).toBeGreaterThan(20);
    expect(problems(registered, toolMap(model))).toEqual([]);
  });

  it("has set_event in place of the two gathering tools, and set_presence merging into it later (6a's second PR)", () => {
    const rows = toolMap(model);
    const fate = (t: string) => rows.find((r) => r.tool === t)?.fate;
    expect(fate("set_event")).toBe("keep");
    for (const t of ["announce_gathering", "cancel_gathering"])
      expect(fate(t)).toBe("retired");
    // Not yet: a session is set by a group's leader alone, so another
    // member says when it'll be back with presence.
    expect(fate("set_presence")).toBe("merge into `set_event`");
    expect(model).toContain(
      '`set_presence` stays listed until a session can carry any member\'s "back at T"',
    );
    expect(model).not.toContain("how many members may miss it");
    expect(model).toContain(
      "Setting a time answers with one fixed sentence: members who can't be woken see it when they next visit. It never says how many, or which.",
    );
  });

  it("names five nouns in its noun table", () => {
    for (const noun of NOUNS) expect(model).toContain(`| **${noun}** |`);
  });

  it("is linked from AGENTS.md and CONTRIBUTING.md", () => {
    expect(readFileSync(path.join(root, "AGENTS.md"), "utf8")).toContain(
      "docs/MODEL.md",
    );
    expect(readFileSync(path.join(root, "CONTRIBUTING.md"), "utf8")).toContain(
      "docs/MODEL.md",
    );
  });
});

describe("the model check refuses drift", () => {
  const base: Row[] = [
    { tool: "post", noun: "Post", fate: "keep" },
    { tool: "send_message", noun: "Post", fate: "merge into `post`" },
    { tool: "catch_up", noun: "Bot", fate: "planned" },
  ];
  const reg = ["post", "send_message"];

  it("passes a consistent map", () => {
    expect(problems(reg, base)).toEqual([]);
  });

  it("refuses a new tool with no row", () => {
    expect(problems([...reg, "set_mood"], base)).toEqual([
      "set_mood: registered in mcp.ts but missing from docs/MODEL.md",
    ]);
  });

  it("refuses a row for a tool that no longer exists", () => {
    expect(problems(["post"], base)).toEqual([
      "send_message: has a row but isn't registered in mcp.ts",
    ]);
  });

  it("keeps a retired tool's row only while the tool is gone", () => {
    const rows: Row[] = [
      ...base,
      { tool: "read_messages", noun: "Channel", fate: "retired" },
    ];
    expect(problems(reg, rows)).toEqual([]);
    expect(problems([...reg, "read_messages"], rows)).toEqual([
      "read_messages: retired, so it shouldn't be registered in mcp.ts",
    ]);
  });

  it("refuses a planned tool once it is built", () => {
    expect(problems([...reg, "catch_up"], base)).toEqual([
      "catch_up: built now, so its fate is no longer planned",
    ]);
  });

  it("refuses a sixth noun", () => {
    const rows = [
      ...base,
      { tool: "x_tool", noun: "Settings", fate: "planned" },
    ];
    expect(problems(reg, rows)).toEqual([
      'x_tool: "Settings" is not one of the five nouns',
    ]);
  });

  it("refuses an unknown fate and a merge into a retired tool", () => {
    const rows: Row[] = [
      { tool: "post", noun: "Post", fate: "retire" },
      { tool: "send_message", noun: "Post", fate: "merge into `post`" },
      { tool: "vote", noun: "Post", fate: "maybe later" },
    ];
    expect(problems(["post", "send_message", "vote"], rows)).toEqual([
      "send_message: merges into post, which the model doesn't keep or plan",
      'vote: unknown fate "maybe later"',
    ]);
  });

  it("refuses a duplicate row", () => {
    expect(
      problems(reg, [...base, { tool: "post", noun: "Post", fate: "keep" }]),
    ).toEqual(["post: more than one row"]);
  });

  it("refuses a target surface over the cap", () => {
    const rows: Row[] = Array.from(
      { length: TARGET_SURFACE_MAX + 1 },
      (_, i) => ({
        tool: `t_${String.fromCharCode(97 + i)}`,
        noun: "Bot",
        fate: "planned",
      }),
    );
    expect(problems([], rows)).toEqual([
      `target surface is ${TARGET_SURFACE_MAX + 1} tools, more than ${TARGET_SURFACE_MAX}`,
    ]);
  });

  it("refuses a malformed row and a tool registered without a literal name", () => {
    const md = "# M\n## Connector tools\n\n| `post` |  Post | keep |\n";
    expect(() => toolMap(md)).toThrow("malformed tool map row");
    expect(() =>
      registeredTools(
        'server.registerTool(\n  "post", {});\nserver.registerTool(name, {});',
      ),
    ).toThrow("only 1 have a literal name");
    expect(registeredTools("server.registerTool(\n  'vote_2', {});")).toEqual([
      "vote_2",
    ]);
  });

  it("reads the real section and ignores rows outside it", () => {
    const md =
      "## Other\n\n| `ghost` | Bot | keep |\n\n## Connector tools\n\n| Tool | Noun | Fate |\n|---|---|---|\n| `post` | Post | keep |\n\n## Next\n\n| `after` | Bot | keep |\n";
    expect(toolMap(md)).toEqual([{ tool: "post", noun: "Post", fate: "keep" }]);
  });
});
