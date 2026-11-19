// Where a real agent runs in an eval: a sealed filesystem (bubblewrap, on
// Linux) with a throwaway home, and an environment built from a short
// allowlist with its own login, never the runner's. A temp folder and a list
// of variables to drop aren't isolation: the agent would still see the
// runner's home, notes and every variable nobody thought to name.
//
// Inside, it sees the operating system's /usr read-only (with /usr/local,
// where a machine's own additions go, hidden), the Node and Claude Code
// executables alone, an /etc written for the eval, a home of its own (its
// key goes there) and an empty /tmp. Nothing it reads comes from the
// runner's settings: the proxy and CA it gets are the eval's own
// (EVAL_HTTPS_PROXY, EVAL_NO_PROXY, EVAL_CA_FILE), never copied from the
// runner's variables, and the hostname is "agent". `probe` checks that from
// inside before any agent runs, planting canaries in the runner's home,
// working folder, temp folder and every variable the runner could leak
// through, and the run refuses if it sees one, or anything else it didn't
// expect.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export const INSIDE_HOME = "/home/agent";
export const INSIDE_WORK = `${INSIDE_HOME}/work`;
export const INSIDE_CA = "/etc/eval-ca.pem";

// The operating system's folders, shared read-only. /etc isn't among them:
// the eval writes its own. On a merged /usr, /bin and friends are links into
// it, and stay links.
const SYSTEM = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64"];

export type Layout = {
  home: string; // the throwaway folder that becomes INSIDE_HOME
  etc: string; // the eval's own /etc (writeEtc)
  etcNames: string[]; // what's in it
  readOnly: string[]; // files or folders shared read-only at the same path
  links: Record<string, string>; // system paths that are links, to their target
  present: string[]; // system paths that exist and aren't links
  hideLocal: boolean; // /usr/local exists, so it's covered
};

export function bwrapArgs(l: Layout): string[] {
  const args = [
    "--unshare-all",
    "--share-net",
    "--die-with-parent",
    "--new-session",
    "--hostname",
    "agent",
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
  if (l.hideLocal) args.push("--tmpfs", "/usr/local");
  args.push("--ro-bind", l.etc, "/etc");
  for (const p of l.readOnly) args.push("--ro-bind", p, p);
  args.push("--bind", l.home, INSIDE_HOME, "--chdir", INSIDE_WORK);
  return args;
}

// The variables the agent gets: a fixed few, its own login, and the eval's
// own proxy and CA, if it was given any (with the local site kept off the
// proxy). The runner's own proxy and CA variables are never read.
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
    PATH: [...bins, "/usr/bin", "/bin"].join(":"),
    TMPDIR: "/tmp",
    LANG: "C.UTF-8",
    TERM: "dumb",
    CLAUDE_CODE_OAUTH_TOKEN: token,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
  };
  const proxy = src.EVAL_HTTPS_PROXY?.trim();
  if (proxy) {
    if (!/^https?:\/\/[^\s]+$/.test(proxy))
      throw new Error("EVAL_HTTPS_PROXY must be an http(s) URL.");
    for (const k of PROXY.filter((k) => !/no_proxy/i.test(k))) env[k] = proxy;
    const none = [src.EVAL_NO_PROXY?.trim(), "localhost", "127.0.0.1"]
      .filter(Boolean)
      .join(",");
    env.NO_PROXY = none;
    env.no_proxy = none;
  }
  if (src.EVAL_CA_FILE?.trim()) for (const k of CA) env[k] = INSIDE_CA;
  return env;
}

// The eval's own /etc: an account for the agent, local names only, the
// system's library index (where the dynamic linker finds libraries), the
// name servers alone from the host's resolver settings, and the eval's CA
// file if it has one. Nothing else of the host's /etc.
export function writeEtc(
  dir: string,
  src: Record<string, string | undefined>,
): string[] {
  mkdirSync(dir, { recursive: true });
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  const files: Record<string, string> = {
    passwd: `agent:x:${uid}:${gid}:agent:${INSIDE_HOME}:/bin/sh\n`,
    group: `agent:x:${gid}:\n`,
    hosts: "127.0.0.1 localhost\n::1 localhost\n",
    "nsswitch.conf": "passwd: files\ngroup: files\nhosts: files dns\n",
    "resolv.conf": nameServers(
      existsSync("/etc/resolv.conf")
        ? readFileSync("/etc/resolv.conf", "utf8")
        : "",
    ),
  };
  for (const [name, body] of Object.entries(files))
    writeFileSync(path.join(dir, name), body);
  const names = Object.keys(files);
  if (existsSync("/etc/ld.so.cache")) {
    copyFileSync("/etc/ld.so.cache", path.join(dir, "ld.so.cache"));
    names.push("ld.so.cache");
  }
  const ca = src.EVAL_CA_FILE?.trim();
  if (ca) {
    copyFileSync(ca, path.join(dir, path.basename(INSIDE_CA)));
    names.push(path.basename(INSIDE_CA));
  }
  return names.sort();
}

// Only `nameserver <address>` lines, each an IP address.
export function nameServers(resolv: string): string {
  return resolv
    .split("\n")
    .map((l) => /^nameserver\s+([0-9a-fA-F.:]+)\s*$/.exec(l.trim())?.[1])
    .filter((a): a is string => Boolean(a))
    .map((a) => `nameserver ${a}\n`)
    .join("");
}

// The folder of the Claude Code package the executable lives in: the
// nearest folder above it whose package.json is that package by name. One
// that only lists it (a dependency, a home folder's package.json) isn't, so
// it's never shared in.
export function claudePackage(real: string): string | undefined {
  for (let d = path.dirname(real); d !== path.dirname(d); d = path.dirname(d)) {
    const pj = path.join(d, "package.json");
    if (!existsSync(pj)) continue;
    try {
      if (
        JSON.parse(readFileSync(pj, "utf8"))?.name ===
        "@anthropic-ai/claude-code"
      )
        return d;
    } catch {}
  }
  return undefined;
}

// The Node and Claude Code executables, each shared alone (a package
// install of Claude Code shares its package folder), and the path to run
// Claude Code by.
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
  const real = realpathSync(which);
  const shared = claudePackage(real) ?? real;
  return {
    readOnly: [...new Set([node, shared])],
    bins: [...new Set([path.dirname(node), path.dirname(real)])],
    claude: real,
  };
}

export function layout(
  home: string,
  etc: string,
  etcNames: string[],
  readOnly: string[],
): Layout {
  const links: Record<string, string> = {};
  const present: string[] = [];
  for (const p of SYSTEM) {
    if (!existsSync(p)) continue;
    if (lstatSync(p).isSymbolicLink()) links[p] = readlinkSync(p);
    else present.push(p);
  }
  return {
    home,
    etc,
    etcNames,
    readOnly,
    links,
    present,
    hideLocal: present.includes("/usr") && existsSync("/usr/local"),
  };
}

// What the sandbox should show in a folder the runner's things could be in:
// only the way down to what was shared, and in /etc, the eval's own files.
export function expectedEntries(l: Layout, dir: string): string[] {
  if (dir === "/etc") return [...l.etcNames].sort();
  const shared = [
    ...l.readOnly,
    ...l.present,
    ...Object.keys(l.links),
    INSIDE_HOME,
    "/etc",
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

// Canaries: a random word planted in a file in each of the runner's places
// and in every variable the runner could pass on (the proxy and CA ones, a
// login, and one nobody named). If the agent's side ever shows the word,
// something of the runner's got through.
export type Canaries = {
  word: string;
  files: string[];
  env: Record<string, string>;
  remove: () => void;
};
export function plantCanaries(places: string[]): Canaries {
  const word = `canary-${randomBytes(12).toString("hex")}`;
  const files: string[] = [];
  for (const dir of [...new Set(places)]) {
    const f = path.join(dir, `.first-visit-${word}`);
    try {
      writeFileSync(f, `${word}\n`, { mode: 0o600 });
      files.push(f);
    } catch {
      // A place the runner can't write to holds nothing it wrote either.
    }
  }
  const env: Record<string, string> = {
    CLAUDE_CODE_OAUTH_TOKEN: word,
    CLAUDE_CODE_USER_EMAIL: `${word}@example.test`,
    FIRST_VISIT_UNNAMED: word,
  };
  for (const k of [...PROXY, ...CA])
    env[k] = k.startsWith("NO") || /no_proxy/.test(k) ? word : `http://${word}`;
  return {
    word,
    files,
    env,
    remove: () => {
      for (const f of files) rmSync(f, { force: true });
    },
  };
}

// A shell line listing every file under root holding the word, skipping the
// paths given by their full path, never by name, so a folder that only
// shares a name with one (a "usr" or a "node" anywhere else) is still read.
export function canaryGrep(word: string, skip: string[], root = "/"): string {
  const q = (s: string) => `'${s.replace(/'/g, "")}'`;
  // find -path takes a pattern, so its special characters are escaped.
  const exact = (p: string) => q(p.replace(/[*?[\]\\]/g, "\\$&"));
  const prune = skip.map((p) => `-path ${exact(p)}`).join(" -o ");
  return `find ${q(root)} ${prune ? `\\( ${prune} \\) -prune -o ` : ""}-type f -print0 2>/dev/null | xargs -0 -r grep -lF -- ${q(word)} 2>/dev/null`;
}

// Looks from inside, with the same layout and environment the agent gets.
// Returns what it saw that it shouldn't have, empty when sealed: any
// variable outside the allowlist, any entry it didn't expect in the folders
// watched, a planted file, and the canary word in a variable or in any file
// outside the operating system's /usr and the shared executables.
export function probe(
  l: Layout,
  env: Record<string, string>,
  watch: string[],
  canaries?: Pick<Canaries, "word" | "files">,
): string[] {
  const q = (s: string) => `'${s.replace(/'/g, "")}'`;
  const dirs = [
    ...new Set(["/", "/home", "/tmp", "/etc", "/usr/local", ...watch]),
  ];
  const script = [
    "env | cut -d= -f1",
    "echo ---",
    ...dirs.map(
      (d) => `if [ -d ${q(d)} ]; then echo "@${d}"; ls -A ${q(d)}; fi`,
    ),
    "echo ---",
    ...(canaries
      ? [
          `env | grep -qF ${q(canaries.word)} && echo "a variable"`,
          ...canaries.files.map(
            (f) => `[ -e ${q(f)} ] && echo ${q(`file ${f}`)}`,
          ),
          `${canaryGrep(canaries.word, ["/proc", "/sys", "/dev", "/usr", ...l.readOnly])} | sed 's/^/file /'`,
        ]
      : []),
    "true",
  ].join("\n");
  const run = spawnSync("bwrap", [...bwrapArgs(l), "/bin/sh", "-c", script], {
    env: env as NodeJS.ProcessEnv,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (run.error || run.status !== 0)
    return [
      `the sandbox didn't start: ${run.error?.message ?? run.stderr.slice(0, 300)}`,
    ];
  const [envPart = "", fsPart = "", canaryPart = ""] =
    run.stdout.split("---\n");
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
  for (const line of canaryPart.split("\n").filter(Boolean))
    seen.push(`the canary in ${line}`);
  return seen;
}
