import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ALLOWED,
  type Allowance,
  type AuditReport,
  judge,
  type LsNode,
  routesTo,
} from "../../scripts/check-audit";

// CI fails on a high or critical advisory in the production tree, except one
// the maintainer allowed, and only while it reads exactly as it did when
// allowed, every route to it runs through the chain it names, and its review
// date hasn't passed.

const URL = "https://github.com/advisories/GHSA-test-0000-0000";
const TODAY = "2026-11-17";
const allow: Allowance = {
  url: URL,
  name: "lib",
  severity: "high",
  range: "<=1.0.0",
  through: ["auth", "runner"],
  reviewBy: "2026-12-17",
  why: "test",
};

function report(
  over: { severity?: string; range?: string; url?: string } = {},
): AuditReport {
  return {
    vulnerabilities: {
      lib: {
        name: "lib",
        via: [
          {
            url: over.url ?? URL,
            name: "lib",
            title: "ReDoS",
            severity: over.severity ?? "high",
            range: over.range ?? "<=1.0.0",
          },
        ],
      },
      runner: { name: "runner", via: ["lib"] },
    },
  };
}

// auth > runner > lib, and auth > runner > glob > lib (deduped).
const inside: LsNode = {
  dependencies: {
    auth: {
      dependencies: {
        runner: {
          dependencies: { lib: {}, glob: { dependencies: { lib: {} } } },
        },
      },
    },
  },
};
const trees = { lib: inside };
const run = (
  r: AuditReport,
  a: Allowance[] = [allow],
  t: Record<string, LsNode> = trees,
  today = TODAY,
) => judge(r, a, t, today);

describe("the audit check", () => {
  it("passes a clean tree", () => {
    expect(run({ vulnerabilities: {} }, [])).toEqual({
      failures: [],
      skipped: [],
    });
  });

  it("fails a high or critical advisory nobody allowed", () => {
    expect(run(report(), [])).toMatchObject({ failures: [expect.any(String)] });
    expect(run(report({ severity: "critical" }), []).failures).toHaveLength(1);
  });

  it("lets a moderate or low one nobody allowed through, as --audit-level=high did", () => {
    expect(run(report({ severity: "moderate" }), []).failures).toEqual([]);
    expect(run(report({ severity: "low" }), []).failures).toEqual([]);
  });

  it("skips an allowed advisory, counting it once however many packages it reaches", () => {
    const r = run(report());
    expect(r.failures).toEqual([]);
    expect(r.skipped).toHaveLength(1);
  });

  it("fails it again once it's reclassified, up or down", () => {
    expect(run(report({ severity: "critical" })).failures[0]).toContain(
      "now critical",
    );
    expect(run(report({ severity: "moderate" })).failures[0]).toContain(
      "now moderate",
    );
  });

  it("fails it again once its range changes, since a fix may be out", () => {
    expect(run(report({ range: "<1.0.1" })).failures[0]).toContain(
      "a fix may be out",
    );
  });

  it("fails it again after its review date", () => {
    expect(run(report(), [allow], trees, "2026-12-17").failures).toEqual([]);
    expect(run(report(), [allow], trees, "2026-12-18").failures[0]).toContain(
      "allowed until 2026-12-17",
    );
  });

  it("fails it again once a route to the package bypasses the allowed chain", () => {
    const server: LsNode = {
      dependencies: {
        ...inside.dependencies,
        server: { dependencies: { lib: {} } },
      },
    };
    expect(run(report(), [allow], { lib: server }).failures[0]).toContain(
      "server > lib",
    );
  });

  it("catches a new route through a package npm shows only once (deduped)", () => {
    // server > glob, where glob's children are listed only under runner.
    const viaDedupe: LsNode = {
      dependencies: {
        ...inside.dependencies,
        server: { dependencies: { glob: {} } },
      },
    };
    expect(run(report(), [allow], { lib: viaDedupe }).failures[0]).toContain(
      "server > glob",
    );
  });

  it("fails when it can't find how the package reaches the site", () => {
    expect(run(report(), [allow], {}).failures[0]).toContain(
      "couldn't find how it reaches",
    );
  });

  it("fails an allowance whose advisory no longer shows, so it gets taken out", () => {
    expect(run({ vulnerabilities: {} }).failures[0]).toContain(
      "no longer shows",
    );
  });

  it("doesn't let an allowance for one advisory cover another in the same package", () => {
    expect(run(report({ url: `${URL}-other` })).failures).toHaveLength(2);
  });

  it("lists every route, deduped ones included", () => {
    expect(routesTo(inside, "lib")).toEqual([
      ["auth", "runner", "lib"],
      ["auth", "runner", "glob", "lib"],
    ]);
  });

  it("allows only the one picomatch ReDoS, through the sign-in library's test runner, for a month", () => {
    expect(ALLOWED).toEqual([
      expect.objectContaining({
        url: "https://github.com/advisories/GHSA-fc5q-39xc-vjpf",
        name: "picomatch",
        severity: "high",
        range: "<=4.0.7",
        through: ["@neondatabase/auth", "better-auth", "vitest"],
        reviewBy: "2026-12-17",
      }),
    ]);
  });

  it("runs in CI in place of the bare npm audit", () => {
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(ci).toContain("scripts/check-audit.ts");
    expect(ci).not.toMatch(/run: npm audit/);
  });
});
