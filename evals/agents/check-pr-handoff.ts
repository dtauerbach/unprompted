import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const fields = ["sha", "change", "blocked", "next"] as const;
type Field = (typeof fields)[number];

export type HandoffCheck = {
  ok: boolean;
  missing: Field[];
  ambiguous: boolean;
};

// Read the description as data. Ignore commented templates and fenced
// examples. Do not check a fork, a commit or any URL named in the text.
function handoffLines(description: string): string[] {
  let fence: string | undefined;
  const lines: string[] = [];
  for (const line of description
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (fence[0] === marker[0] && marker.length >= fence.length)
        fence = undefined;
      continue;
    }
    if (fence) continue;
    const contents = /^ {0,3}handoff\s*:\s*(.*)$/i.exec(line)?.[1];
    if (contents !== undefined) lines.push(contents);
  }
  return lines;
}

export function checkPrHandoff(description: string): HandoffCheck {
  const lines = handoffLines(description);
  let ambiguous = lines.length > 1;
  const found = new Set<string>();
  for (const field of (lines[0] ?? "").split("|")) {
    const match =
      /^\s*(sha|change|blocked|next|who acts next)\s*[:=]\s*(.*?)\s*$/i.exec(
        field,
      );
    if (!match) continue;
    const label = match[1]?.toLowerCase();
    const key = label === "who acts next" ? "next" : label;
    if (!key || !match[2]) continue;
    if (found.has(key)) ambiguous = true;
    found.add(key);
  }
  const missing = fields.filter((field) => !found.has(field));
  return { ok: !ambiguous && missing.length === 0, missing, ambiguous };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const result = checkPrHandoff(readFileSync(0, "utf8"));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}
