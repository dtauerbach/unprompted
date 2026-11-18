import { describe, expect, it } from "vitest";
import {
  ALLOWED_ENV,
  agentEnv,
  bwrapArgs,
  caFiles,
  expectedEntries,
  INSIDE_HOME,
  type Layout,
} from "../../evals/agents/sandbox";

// The seal around a real agent in an eval (evals/agents/sandbox.ts). These
// check what it's built from; the eval itself probes it from inside before
// every run and refuses if it sees more.

const l: Layout = {
  home: "/tmp/first-visit-home-x",
  readOnly: ["/opt/node22", "/root/.ccr/ca-bundle.crt"],
  links: { "/bin": "usr/bin", "/lib": "usr/lib" },
  present: ["/usr", "/etc"],
};

describe("the agent's sandbox", () => {
  it("shares only the system, the installs and its own home", () => {
    const args = bwrapArgs(l);
    const pairs: string[][] = [];
    for (let i = 0; i < args.length; i++)
      if (args[i] === "--ro-bind" || args[i] === "--bind")
        pairs.push([args[i] ?? "", args[i + 1] ?? "", args[i + 2] ?? ""]);
    expect(pairs).toEqual([
      ["--ro-bind", "/usr", "/usr"],
      ["--ro-bind", "/etc", "/etc"],
      ["--ro-bind", "/opt/node22", "/opt/node22"],
      ["--ro-bind", "/root/.ccr/ca-bundle.crt", "/root/.ccr/ca-bundle.crt"],
      ["--bind", l.home, INSIDE_HOME],
    ]);
    expect(args).toContain("--unshare-all");
    expect(args.join(" ")).toContain("--tmpfs /tmp");
    expect(args.join(" ")).toContain("--symlink usr/bin /bin");
    // Nothing of the whole filesystem, the runner's home or the repo.
    expect(args).not.toContain("/");
    expect(args).not.toContain("/home");
    expect(args).not.toContain(process.cwd());
  });

  it("builds the environment from an allowlist with the eval's own login", () => {
    const env = agentEnv(
      {
        HOME: "/home/runner",
        CLAUDE_CODE_OAUTH_TOKEN: "runner's",
        CLAUDE_CODE_USER_EMAIL: "someone@example.test",
        SOMETHING_NOBODY_NAMED: "x",
        HTTPS_PROXY: "http://proxy:8080",
        NO_PROXY: "example.test",
        NODE_EXTRA_CA_CERTS: "/root/.ccr/ca-bundle.crt",
      },
      "eval-token",
      ["/opt/node22/bin"],
    );
    expect(Object.keys(env).every((k) => ALLOWED_ENV.includes(k))).toBe(true);
    expect(env).toMatchObject({
      HOME: INSIDE_HOME,
      CLAUDE_CODE_OAUTH_TOKEN: "eval-token",
      HTTPS_PROXY: "http://proxy:8080",
      NO_PROXY: "example.test,localhost,127.0.0.1",
      no_proxy: "localhost,127.0.0.1",
    });
    expect(env.PATH?.split(":")[0]).toBe("/opt/node22/bin");
    expect(JSON.stringify(env)).not.toMatch(/someone@|runner|NOBODY/);
    expect(caFiles(env)).toEqual(["/root/.ccr/ca-bundle.crt"]);
    expect(() => agentEnv({}, "", [])).toThrow(/own login/);
    // No proxy: the local site is reached directly, and nothing is added.
    expect(agentEnv({}, "t", []).NO_PROXY).toBeUndefined();
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
      "root",
      "tmp",
      "usr",
    ]);
    expect(expectedEntries(l, "/home")).toEqual(["agent"]);
    expect(expectedEntries(l, "/root")).toEqual([".ccr"]);
    expect(expectedEntries(l, "/tmp")).toEqual([]);
    expect(expectedEntries(l, "/mnt")).toEqual([]);
  });
});
