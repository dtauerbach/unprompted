// Where a real agent runs in an eval: a sealed filesystem (bubblewrap, on
// Linux) with a throwaway home, and an environment built from a short
// allowlist with its own login, never the runner's. A temp folder and a list
// of variables to drop aren't isolation: the agent would still see the
// runner's home, notes and every variable nobody thought to name. Inside,
// it sees the system's programs read-only, Node and Claude Code read-only,
// a home of its own (its key goes there) and an empty /tmp, and nothing
// else of the runner's. `probe` checks that from inside before any agent
// runs, and the run refuses if it sees more.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

export const INSIDE_HOME = "/home/agent";
export const INSIDE_WORK = `${INSIDE_HOME}/work`;

// System folders, shared read-only. On a merged /usr, /bin and friends are
// links into it, and stay links.
const SYSTEM = ["/usr", "/etc", "/bin", "/sbin", "/lib", "/lib32", "/lib64"];

export type Layout = {
  home: string; // the throwaway folder that becomes INSIDE_HOME
  readOnly: string[]; // other folders or files shared read-only at the same path
  links: Record<string, string>; // system paths that are links, to their target
  present: string[]; // system paths that exist and aren't links
};

export function bwrapArgs(l: Layout): string[] {
  const args = [
    "--unshare-all",
    "--share-net",
    "--die-with-parent",
    "--new-session",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
  ];
  for (const p of SYSTEM) {
    const to = l.links[p];
    if (to !== undefined) args.push("--symlink", to, p);
    else if (l.present.includes(p)) args.push("--ro-bind", p, p);
  }
  for (const p of l.readOnly) args.push("--ro-bind", p, p);
  args.push("--bind", l.home, INSIDE_HOME, "--chdir", INSIDE_WORK);
  return args;
}

// The variables the agent gets: a fixed few, its own login, and the
// network's proxy settings (with the local site kept off the proxy).
const PROXY = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "https_proxy",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
];
const CA = ["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"];
export const ALLOWED_ENV = [
  "HOME",
  "PATH",
  "TMPDIR",
  "LANG",
  "TERM",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "DISABLE_AUTOUPDATER",
  ...PROXY,
  ...CA,
];
export function agentEnv(
  src: Record<string, string | undefined>,
  token: string,
  bins: string[],
): Record<string, string> {
  if (!token) throw new Error("The agent needs its own login token.");
  const env: Record<string, string> = {
    HOME: INSIDE_HOME,
    PATH: [...bins, "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
    TMPDIR: "/tmp",
    LANG: "C.UTF-8",
    TERM: "dumb",
    CLAUDE_CODE_OAUTH_TOKEN: token,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
  };
  for (const k of [...PROXY, ...CA]) {
    const v = src[k];
    if (v) env[k] = v;
  }
  if (PROXY.some((k) => env[k] && !/no_proxy/i.test(k)))
    for (const k of ["NO_PROXY", "no_proxy"])
      env[k] = [env[k], "localhost", "127.0.0.1"].filter(Boolean).join(",");
  return env;
}

// The CA files the proxy settings name, shared read-only so TLS works.
export function caFiles(env: Record<string, string>): string[] {
  return CA.flatMap((k) => (env[k] ? [env[k]] : []));
}

// Node's and Claude Code's installs: the folders to share read-only, and the
// path to run Claude Code by.
export function installs(): {
  readOnly: string[];
  bins: string[];
  claude: string;
} {
  const which = spawnSync("sh", ["-c", "command -v claude"], {
    encoding: "utf8",
  }).stdout.trim();
  if (!which) throw new Error("Claude Code (claude) isn't on PATH.");
  const node = realpathSync(process.execPath);
  const nodePrefix = path.dirname(path.dirname(node));
  const real = realpathSync(which);
  // A package install: share its package folder; a native one: its folder.
  let pkg = path.dirname(real);
  for (let d = pkg; d !== path.dirname(d); d = path.dirname(d)) {
    const pj = path.join(d, "package.json");
    if (
      existsSync(pj) &&
      /"@anthropic-ai\/claude-code"/.test(readFileSync(pj, "utf8"))
    ) {
      pkg = d;
      break;
    }
  }
  const readOnly = [nodePrefix];
  if (!real.startsWith(`${nodePrefix}/`)) readOnly.push(pkg);
  return {
    readOnly,
    bins: [path.dirname(node), path.dirname(real)],
    claude: real,
  };
}

export function layout(home: string, readOnly: string[]): Layout {
  const links: Record<string, string> = {};
  const present: string[] = [];
  for (const p of SYSTEM) {
    if (!existsSync(p)) continue;
    if (lstatSync(p).isSymbolicLink()) links[p] = readlinkSync(p);
    else present.push(p);
  }
  return { home, readOnly, links, present };
}

// What the sandbox should show at each folder the runner's things could be
// in: only the path down to what was shared.
export function expectedEntries(l: Layout, dir: string): string[] {
  const shared = [
    ...l.readOnly,
    ...l.present,
    ...Object.keys(l.links),
    INSIDE_HOME,
    "/proc",
    "/dev",
    "/tmp",
  ];
  const under = dir === "/" ? "/" : `${dir}/`;
  const names = new Set<string>();
  for (const p of shared)
    if (p.startsWith(under) && p !== dir)
      names.add(p.slice(under.length).split("/")[0] ?? "");
  names.delete("");
  return [...names].sort();
}

// Looks from inside, with the same layout and environment the agent gets.
// Returns what it saw that it shouldn't have, empty when sealed.
export function probe(
  l: Layout,
  env: Record<string, string>,
  watch: string[],
): string[] {
  const dirs = [...new Set(["/", "/home", "/tmp", ...watch])];
  const script = [
    "env | cut -d= -f1",
    "echo ---",
    ...dirs.map(
      (d) =>
        `if [ -e '${d.replace(/'/g, "")}' ]; then echo "@${d.replace(/'/g, "")}"; ls -A '${d.replace(/'/g, "")}'; fi`,
    ),
  ].join("\n");
  const run = spawnSync("bwrap", [...bwrapArgs(l), "/bin/sh", "-c", script], {
    env: env as NodeJS.ProcessEnv,
    encoding: "utf8",
  });
  if (run.error || run.status !== 0)
    return [
      `the sandbox didn't start: ${run.error?.message ?? run.stderr.slice(0, 300)}`,
    ];
  const [envPart = "", fsPart = ""] = run.stdout.split("---\n");
  const seen: string[] = [];
  for (const k of envPart.split("\n").filter(Boolean))
    if (
      !ALLOWED_ENV.includes(k) &&
      !["PWD", "SHLVL", "_", "OLDPWD"].includes(k)
    )
      seen.push(`variable ${k}`);
  let at = "";
  for (const line of fsPart.split("\n").filter(Boolean)) {
    if (line.startsWith("@")) {
      at = line.slice(1);
      continue;
    }
    if (!expectedEntries(l, at).includes(line))
      seen.push(`${at === "/" ? "" : at}/${line}`);
  }
  return seen;
}
