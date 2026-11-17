import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ALLOWED,
  type Allowance,
  type AuditReport,
  judge,
} from "../../scripts/check-audit";

// CI fails on a high or critical advisory in the production tree, except one
// the maintainer allowed, and only while it reads as it did when allowed.

const URL = "https://github.com/advisories/GHSA-test-0000-0000";
const allow: Allowance = {
  url: URL,
  name: "lib",
  range: "<=1.0.0",
  effects: ["runner"],
  why: "test",
};

function report(
  over: {
    severity?: string;
    range?: string;
    effects?: string[];
    url?: string;
  } = {},
): AuditReport {
  const url = over.url ?? URL;
  return {
    vulnerabilities: {
      lib: {
        name: "lib",
        via: [
          {
            url,
            name: "lib",
            title: "ReDoS",
            severity: over.severity ?? "high",
            range: over.range ?? "<=1.0.0",
          },
        ],
        effects: over.effects ?? ["runner"],
      },
      runner: { name: "runner", via: ["lib"], effects: [] },
    },
  };
}

describe("the audit check", () => {
  it("passes a clean tree", () => {
    expect(judge({ vulnerabilities: {} }, [])).toEqual({
      failures: [],
      skipped: [],
    });
  });

  it("fails a high or critical advisory nobody allowed", () => {
    expect(judge(report(), []).failures).toHaveLength(1);
    expect(judge(report({ severity: "critical" }), []).failures).toHaveLength(
      1,
    );
  });

  it("lets a moderate or low one through, as --audit-level=high did", () => {
    expect(judge(report({ severity: "moderate" }), []).failures).toEqual([]);
    expect(judge(report({ severity: "low" }), []).failures).toEqual([]);
  });

  it("skips an allowed advisory, counting it once however many packages it reaches", () => {
    const r = judge(report(), [allow]);
    expect(r.failures).toEqual([]);
    expect(r.skipped).toHaveLength(1);
  });

  it("fails it again once its range changes, since a fix may be out", () => {
    const r = judge(report({ range: "<1.0.1" }), [allow]);
    expect(r.failures[0]).toContain("a fix may be out");
  });

  it("fails it again once another package pulls the library in", () => {
    const r = judge(report({ effects: ["runner", "server"] }), [allow]);
    expect(r.failures[0]).toContain("server");
  });

  it("fails an allowance whose advisory no longer shows, so it gets taken out", () => {
    const r = judge({ vulnerabilities: {} }, [allow]);
    expect(r.failures[0]).toContain("no longer shows");
  });

  it("doesn't let an allowance for one advisory cover another in the same package", () => {
    const r = judge(report({ url: `${URL}-other` }), [allow]);
    expect(r.failures).toHaveLength(2);
  });

  it("allows only the one picomatch ReDoS, until a fix ships", () => {
    expect(ALLOWED.map((a) => a.url)).toEqual([
      "https://github.com/advisories/GHSA-fc5q-39xc-vjpf",
    ]);
    expect(ALLOWED[0]?.name).toBe("picomatch");
    expect(ALLOWED[0]?.range).toBe("<=4.0.7");
  });

  it("runs in CI in place of the bare npm audit", () => {
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(ci).toContain("scripts/check-audit.ts");
    expect(ci).not.toMatch(/run: npm audit/);
  });
});
