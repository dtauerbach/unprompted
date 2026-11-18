import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  ALLOWED_ENV,
  agentEnv,
  bwrapArgs,
  canaryGrep,
  claudePackage,
  expectedEntries,
  INSIDE_CA,
  INSIDE_HOME,
  type Layout,
  layout,
  nameServers,
  plantCanaries,
  probe,
  writeEtc,
} from "../../evals/agents/sandbox";

// The seal around a real agent in an eval (evals/agents/sandbox.ts). These
// check what it's built from, and, where bubblewrap runs, look from inside
// for canaries planted where the runner's things are.

const l: Layout = {
  home: "/tmp/first-visit-home-x",
  etc: "/tmp/first-visit-etc-x",
  etcNames: ["group", "hosts", "passwd"],
  readOnly: ["/opt/node22/bin/node", "/opt/claude-code/bin/claude"],
  links: { "/bin": "usr/bin", "/lib": "usr/lib" },
  present: ["/usr"],
  hideLocal: true,
};

const scratch: string[] = [];
const temp = (name: string) => {
  const d = mkdtempSync(path.join(tmpdir(), `${name}-`));
  scratch.push(d);
  return d;
};
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

// The runner's own settings, every one of which must stay outside.
const RUNNER = {
  HOME: "/home/runner",
  CLAUDE_CODE_OAUTH_TOKEN: "runner's",
  CLAUDE_CODE_USER_EMAIL: "someone@example.test",
  SOMETHING_NOBODY_NAMED: "x",
  HTTPS_PROXY: "http://runner-proxy:8080",
  https_proxy: "http://runner-proxy:8080",
  NO_PROXY: "runner.example.test",
  NODE_EXTRA_CA_CERTS: "/root/.runner/ca.crt",
  SSL_CERT_FILE: "/root/.runner/ca.crt",
};

describe("the agent's sandbox", () => {
  it("shares only the system, two executables, its own /etc and home", () => {
    const args = bwrapArgs(l);
    const pairs: string[][] = [];
    for (let i = 0; i < args.length; i++)
      if (args[i] === "--ro-bind" || args[i] === "--bind")
        pairs.push([args[i] ?? "", args[i + 1] ?? "", args[i + 2] ?? ""]);
    expect(pairs).toEqual([
      ["--ro-bind", "/usr", "/usr"],
      ["--ro-bind", l.etc, "/etc"],
      ["--ro-bind", "/opt/node22/bin/node", "/opt/node22/bin/node"],
      [
        "--ro-bind",
        "/opt/claude-code/bin/claude",
        "/opt/claude-code/bin/claude",
      ],
      ["--bind", l.home, INSIDE_HOME],
    ]);
    const all = args.join(" ");
    expect(args).toContain("--unshare-all");
    expect(all).toContain("--hostname agent");
    expect(all).toContain("--tmpfs /tmp");
    expect(all).toContain("--symlink usr/bin /bin");
    // /usr/local, where a machine's own additions go, is covered, after /usr
    // is shared and before anything is shared on top of it.
    const at = (s: string) => all.indexOf(s);
    expect(at("--ro-bind /usr /usr")).toBeGreaterThan(-1);
    expect(at("--tmpfs /usr/local")).toBeGreaterThan(at("--ro-bind /usr /usr"));
    expect(at("--tmpfs /usr/local")).toBeLessThan(at("--ro-bind /opt"));
    // Nothing of the host's /etc, the whole filesystem, the runner's home or
    // the repo.
    expect(all).not.toContain("--ro-bind /etc");
    expect(args).not.toContain("/");
    expect(args).not.toContain("/home");
    expect(args).not.toContain(process.cwd());
    expect(bwrapArgs({ ...l, hideLocal: false }).join(" ")).not.toContain(
      "/usr/local",
    );
  });

  it("never passes on the runner's proxy, certificates or login", () => {
    const env = agentEnv(RUNNER, "eval-token", ["/opt/node22/bin"]);
    expect(Object.keys(env).every((k) => ALLOWED_ENV.includes(k))).toBe(true);
    expect(env).toMatchObject({
      HOME: INSIDE_HOME,
      CLAUDE_CODE_OAUTH_TOKEN: "eval-token",
    });
    expect(env.PATH?.split(":")[0]).toBe("/opt/node22/bin");
    for (const k of [
      "HTTPS_PROXY",
      "https_proxy",
      "NO_PROXY",
      "NODE_EXTRA_CA_CERTS",
      "SSL_CERT_FILE",
    ])
      expect(env[k]).toBeUndefined();
    expect(JSON.stringify(env)).not.toMatch(/someone@|runner|NOBODY/);
    expect(() => agentEnv({}, "", [])).toThrow(/own login/);
  });

  it("gives the agent the eval's own proxy and certificate, if any", () => {
    const env = agentEnv(
      {
        ...RUNNER,
        EVAL_HTTPS_PROXY: "http://127.0.0.1:9999",
        EVAL_NO_PROXY: "example.test",
        EVAL_CA_FILE: "/somewhere/eval-ca.pem",
      },
      "eval-token",
      [],
    );
    expect(env).toMatchObject({
      HTTPS_PROXY: "http://127.0.0.1:9999",
      https_proxy: "http://127.0.0.1:9999",
      HTTP_PROXY: "http://127.0.0.1:9999",
      http_proxy: "http://127.0.0.1:9999",
      NO_PROXY: "example.test,localhost,127.0.0.1",
      no_proxy: "example.test,localhost,127.0.0.1",
      NODE_EXTRA_CA_CERTS: INSIDE_CA,
      SSL_CERT_FILE: INSIDE_CA,
    });
    expect(JSON.stringify(env)).not.toMatch(/runner|somewhere/);
    expect(() =>
      agentEnv({ EVAL_HTTPS_PROXY: "file:///etc/passwd" }, "t", []),
    ).toThrow(/http\(s\) URL/);
  });

  it("writes an /etc of its own, with the name servers alone", () => {
    expect(
      nameServers(
        "# a comment\nnameserver 8.8.8.8\nsearch corp.example.test\nnameserver 2001:db8::1\nnameserver evil; rm\noptions ndots:5\n",
      ),
    ).toBe("nameserver 8.8.8.8\nnameserver 2001:db8::1\n");
    const ca = path.join(temp("first-visit-ca"), "ca.pem");
    writeFileSync(ca, "a certificate\n");
    const etc = temp("first-visit-etc");
    const names = writeEtc(etc, { ...RUNNER, EVAL_CA_FILE: ca });
    expect(readdirSync(etc).sort()).toEqual(names);
    expect(names).toEqual(
      expect.arrayContaining([
        "eval-ca.pem",
        "group",
        "hosts",
        "nsswitch.conf",
        "passwd",
        "resolv.conf",
      ]),
    );
    expect(
      names.every((n) =>
        [
          "eval-ca.pem",
          "group",
          "hosts",
          "ld.so.cache",
          "nsswitch.conf",
          "passwd",
          "resolv.conf",
        ].includes(n),
      ),
    ).toBe(true);
    expect(readFileSync(path.join(etc, "passwd"), "utf8")).toMatch(
      /^agent:x:\d+:\d+:agent:\/home\/agent:\/bin\/sh\n$/,
    );
    expect(readFileSync(path.join(etc, "hosts"), "utf8")).not.toMatch(
      /[a-z]+\.[a-z]/,
    );
    // No certificate asked for, none written.
    expect(writeEtc(temp("first-visit-etc"), RUNNER)).not.toContain(
      "eval-ca.pem",
    );
  });

  it("plants canaries and takes them away", () => {
    const dir = temp("first-visit-runner");
    const c = plantCanaries([dir, dir, "/no/such/folder"]);
    expect(c.files).toHaveLength(1);
    expect(readFileSync(c.files[0] ?? "", "utf8")).toContain(c.word);
    for (const k of [
      "HTTPS_PROXY",
      "https_proxy",
      "NO_PROXY",
      "NODE_EXTRA_CA_CERTS",
      "SSL_CERT_FILE",
      "CLAUDE_CODE_USER_EMAIL",
      "FIRST_VISIT_UNNAMED",
    ])
      expect(c.env[k]).toContain(c.word);
    c.remove();
    expect(existsSync(c.files[0] ?? "")).toBe(false);
  });

  it("expects to see only the way down to what it shared", () => {
    expect(expectedEntries(l, "/")).toEqual([
      "bin",
      "dev",
      "etc",
      "home",
      "lib",
      "opt",
      "proc",
      "tmp",
      "usr",
    ]);
    expect(expectedEntries(l, "/home")).toEqual(["agent"]);
    expect(expectedEntries(l, "/opt")).toEqual(["claude-code", "node22"]);
    expect(expectedEntries(l, "/etc")).toEqual(["group", "hosts", "passwd"]);
    expect(expectedEntries(l, "/usr/local")).toEqual([]);
    expect(expectedEntries(l, "/tmp")).toEqual([]);
    expect(expectedEntries(l, "/root")).toEqual([]);
  });

  it("shares Claude Code's own package folder, never one that only lists it", () => {
    const root = temp("claude-pkg");
    // A home folder whose package.json lists Claude Code as a dependency,
    // with a single-file install below it.
    const home = path.join(root, "home");
    mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
    writeFileSync(
      path.join(home, "package.json"),
      JSON.stringify({ dependencies: { "@anthropic-ai/claude-code": "1" } }),
    );
    const single = path.join(home, ".local", "bin", "claude");
    writeFileSync(single, "");
    expect(claudePackage(single)).toBeUndefined();
    // A package install: the folder whose package.json is the package.
    const pkg = path.join(
      root,
      "lib",
      "node_modules",
      "@anthropic-ai",
      "claude-code",
    );
    mkdirSync(path.join(pkg, "bin"), { recursive: true });
    writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({ name: "@anthropic-ai/claude-code", version: "1" }),
    );
    writeFileSync(path.join(pkg, "bin", "claude.js"), "");
    expect(claudePackage(path.join(pkg, "bin", "claude.js"))).toBe(pkg);
    // A package.json that isn't JSON is passed over, not trusted.
    const broken = path.join(root, "broken");
    mkdirSync(path.join(broken, "bin"), { recursive: true });
    writeFileSync(
      path.join(broken, "package.json"),
      '"@anthropic-ai/claude-code"',
    );
    expect(claudePackage(path.join(broken, "bin", "claude"))).toBeUndefined();
  });

  it("looks for the canary everywhere but the paths it skips, by full path", () => {
    const root = temp("canary-grep");
    const word = "canary-word-123";
    const put = (rel: string) => {
      const f = path.join(root, rel);
      mkdirSync(path.dirname(f), { recursive: true });
      writeFileSync(f, `x ${word} x`);
      return f;
    };
    const skipped = put("usr/lib/thing");
    const sharedNode = put("opt/node/bin/node");
    // The same names elsewhere are still read.
    const nestedUsr = put("home/runner/usr/secret");
    const otherNode = put("srv/node");
    const odd = put("we[ird]/f*le");
    const out = spawnSync(
      "sh",
      [
        "-c",
        canaryGrep(
          word,
          [path.join(root, "usr"), path.join(root, "opt/node/bin/node")],
          root,
        ),
      ],
      { encoding: "utf8" },
    ).stdout;
    const found = out.split("\n").filter(Boolean).sort();
    expect(found).toEqual([nestedUsr, odd, otherNode].sort());
    expect(found).not.toContain(skipped);
    expect(found).not.toContain(sharedNode);
    // A skipped path with pattern characters skips only itself.
    const out2 = spawnSync(
      "sh",
      ["-c", canaryGrep(word, [path.join(root, "we[ird]")], root)],
      { encoding: "utf8" },
    ).stdout;
    expect(out2).not.toContain("f*le");
    expect(out2).toContain(nestedUsr);
  });
});

// From inside, where bubblewrap can run here (not on every CI runner).
const bwrap =
  process.platform === "linux" &&
  spawnSync("bwrap", ["--unshare-all", "--ro-bind", "/", "/", "/bin/true"], {
    stdio: "ignore",
  }).status === 0;

describe.runIf(bwrap)("the agent's sandbox, from inside", () => {
  // A stand-in for the runner: a home and a working folder with a canary
  // each, and canaries in every variable it could leak through.
  function setUp() {
    const runner = temp("first-visit-runner");
    const work = path.join(runner, "repo");
    mkdirSync(work);
    const home = temp("first-visit-home");
    mkdirSync(path.join(home, "work"));
    const etc = temp("first-visit-etc");
    const box = layout(home, etc, writeEtc(etc, {}), []);
    const canaries = plantCanaries([runner, work, tmpdir()]);
    scratch.push(...canaries.files);
    const env = agentEnv({ ...RUNNER, ...canaries.env }, "eval-token", []);
    return { runner, work, box, canaries, env, watch: [runner, work] };
  }

  it("finds no canary and nothing else it didn't expect", () => {
    const s = setUp();
    try {
      expect(probe(s.box, s.env, s.watch, s.canaries)).toEqual([]);
    } finally {
      s.canaries.remove();
    }
  });

  it("sees a canary shared in by mistake", () => {
    const s = setUp();
    try {
      const leaky = { ...s.box, readOnly: [s.runner] };
      const seen = probe(leaky, s.env, s.watch, s.canaries);
      expect(seen.some((x) => x.startsWith("the canary in file"))).toBe(true);
      expect(seen.some((x) => x.includes(".first-visit-canary-"))).toBe(true);
    } finally {
      s.canaries.remove();
    }
  });

  it("sees a canary passed in a variable", () => {
    const s = setUp();
    try {
      const seen = probe(
        s.box,
        { ...s.env, FIRST_VISIT_UNNAMED: s.canaries.word },
        s.watch,
        s.canaries,
      );
      expect(seen).toContain("variable FIRST_VISIT_UNNAMED");
      expect(seen).toContain("the canary in a variable");
      const proxied = probe(
        s.box,
        { ...s.env, HTTPS_PROXY: `http://${s.canaries.word}` },
        s.watch,
        s.canaries,
      );
      expect(proxied).toEqual(["the canary in a variable"]);
    } finally {
      s.canaries.remove();
    }
  });

  it("sees the host's /etc if it were shared", () => {
    const s = setUp();
    try {
      const host = { ...s.box, etc: "/etc" };
      expect(
        probe(host, s.env, s.watch).some((x) => x.startsWith("/etc/")),
      ).toBe(true);
    } finally {
      s.canaries.remove();
    }
  });
});
