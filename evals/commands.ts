// /skill.md's commands, read the way bash would read them but never run by a
// shell. The onboarding eval runs them, so it checks first that each is one
// curl command, to the site under test, with nothing a shell would act on
// beyond $HOME. A page that fails the check runs nothing.

export function skillCommands(markdown: string): string[] {
  return [...markdown.matchAll(/```\n([\s\S]*?)```/g)].map((m) =>
    (m[1] ?? "").replace(/\\\n\s*/g, " ").trim(),
  );
}

// Why a command isn't one plain curl command, or null if it is. Agents allowed
// only curl stalled on anything more, and the eval won't run anything more.
export function notPlainCurl(cmd: string): string | null {
  if (!cmd.startsWith("curl ")) return "doesn't start with curl";
  if (cmd.includes("\n")) return "more than one line";
  if (/[|;&<>`]/.test(cmd)) return "has a shell operator";
  if (/\$(?!HOME\b)/.test(cmd)) return "uses a variable other than $HOME";
  if (/Bearer \$/.test(cmd)) return "puts a key on the command line";
  return null;
}

// Splits like bash: '…' is literal, "…" honours \" \\ \$ and \`, and a bare
// backslash escapes the next character. $HOME becomes `home` only where bash
// would expand it: unquoted or in double quotes.
export function words(cmd: string, home = "$HOME"): string[] {
  const expands = (at: number) =>
    cmd.startsWith("$HOME", at) && !/[A-Za-z0-9_]/.test(cmd[at + 5] ?? "");
  const out: string[] = [];
  let cur: string | null = null;
  let i = 0;
  while (i < cmd.length) {
    const c = cmd[i] ?? "";
    if (c === " " || c === "\t") {
      if (cur !== null) out.push(cur);
      cur = null;
      i++;
      continue;
    }
    cur ??= "";
    if (c === "'") {
      const end = cmd.indexOf("'", i + 1);
      if (end < 0) throw new Error("unclosed '");
      cur += cmd.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      i++;
      while (i < cmd.length && cmd[i] !== '"') {
        const next = cmd[i + 1] ?? "";
        if (expands(i)) {
          cur += home;
          i += 5;
        } else if (cmd[i] === "\\" && '"\\$`'.includes(next)) {
          cur += next;
          i += 2;
        } else {
          cur += cmd[i];
          i++;
        }
      }
      if (i >= cmd.length) throw new Error('unclosed "');
      i++;
    } else if (c === "\\") {
      cur += cmd[i + 1] ?? "";
      i += 2;
    } else if (expands(i)) {
      cur += home;
      i += 5;
    } else {
      cur += c;
      i++;
    }
  }
  if (cur !== null) out.push(cur);
  return out;
}

// The curl options the page uses. Those that name a file must name one in
// the throwaway HOME.
const FLAGS = new Set(["-s", "-S", "-sS", "-f", "--create-dirs"]);
const WITH_VALUE = new Set(["-X", "-H", "-d", "-o", "-w"]);
const FILE_VALUE = new Set(["-o"]);

// curl's arguments for one of the page's commands, or a throw. Its URL must be
// on the site under test, so the page can't send a run's headers elsewhere,
// and its files must be in the throwaway HOME.
export function curlArgs(cmd: string, base: string, home: string): string[] {
  const why = notPlainCurl(cmd);
  if (why) throw new Error(`Not a plain curl command (${why}): ${cmd}`);
  const [, ...args] = words(cmd, home);
  const inHome = (f: string) => !f.includes("..") && f.startsWith(`${home}/`);
  let urls = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (FLAGS.has(a)) continue;
    if (WITH_VALUE.has(a)) {
      const v = args[++i];
      if (v === undefined) throw new Error(`${a} has no value: ${cmd}`);
      const file = FILE_VALUE.has(a) ? v : v.startsWith("@") ? v.slice(1) : "";
      if (file && !inHome(file))
        throw new Error(`${a} names a file outside HOME: ${cmd}`);
      continue;
    }
    if (a.startsWith("-")) throw new Error(`Unexpected option ${a}: ${cmd}`);
    if (!a.startsWith(`${base}/`))
      throw new Error(`${a} is not a URL on ${base}: ${cmd}`);
    urls++;
  }
  if (urls !== 1) throw new Error(`Not exactly one URL: ${cmd}`);
  return args;
}
