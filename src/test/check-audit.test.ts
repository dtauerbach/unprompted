import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALLOWED,
  type Allowance,
  type AuditReport,
  invokedAs,
  judge,
  type LsNode,
  routesTo,
  type Vulnerability,
} from "../../scripts/check-audit";

// CI fails on a high or critical advisory in the production tree, except one
// the maintainer allowed, and only while it reads exactly as it did when
// allowed, package.json and the lockfile are the ones reviewed, every route to
// it runs through the chain it names, and its review date hasn't passed.

const URL = "https://github.com/advisories/GHSA-test-0000-0000";
const TODAY = "2026-11-17";
const LOCK = "a".repeat(64);
const MANIFEST = "c".repeat(64);
const allow: Allowance = {
  url: URL,
  name: "lib",
  severity: "high",
  range: "<=1.0.0",
  through: ["auth", "runner"],
  reviewBy: "2026-12-17",
  manifest: MANIFEST,
  lockfile: LOCK,
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

// A package at its installed path, with what it depends on.
const node = (path: string, deps?: Record<string, LsNode>): LsNode => ({
  path: `/site/node_modules/${path}`,
  ...(deps ? { dependencies: deps } : {}),
});

// auth > runner > lib, and auth > runner > glob > lib (deduped).
const insideDeps = {
  auth: node("auth", {
    runner: node("runner", {
      lib: node("lib"),
      glob: node("glob", { lib: node("lib") }),
    }),
  }),
};
const inside: LsNode = { dependencies: insideDeps };
const trees = { lib: inside };
const run = (
  r: AuditReport,
  a: Allowance[] = [allow],
  t: Record<string, LsNode> = trees,
  today = TODAY,
  lockfile = LOCK,
  manifest = MANIFEST,
) => judge(r, a, t, today, { manifest, lockfile });

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
      "may have been fixed",
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
        ...insideDeps,
        server: node("server", { lib: node("lib") }),
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
        ...insideDeps,
        server: node("server", { glob: node("glob") }),
      },
    };
    expect(run(report(), [allow], { lib: viaDedupe }).failures[0]).toContain(
      "server > glob",
    );
  });

  it("keeps two installed copies of one package apart", () => {
    // server has its own copy of glob, which doesn't lead to lib: no route.
    const twoCopies: LsNode = {
      dependencies: {
        ...insideDeps,
        server: node("server", { glob: node("server/node_modules/glob") }),
      },
    };
    expect(run(report(), [allow], { lib: twoCopies }).failures).toEqual([]);
  });

  it("fails once package-lock.json isn't the one reviewed", () => {
    const r = run(report(), [allow], trees, TODAY, "b".repeat(64));
    expect(r.failures[0]).toContain("package-lock.json");
    expect(r.skipped).toEqual([]);
  });

  it("fails once package.json isn't the one reviewed, though npm ci would accept it", () => {
    const r = run(report(), [allow], trees, TODAY, LOCK, "d".repeat(64));
    expect(r.failures[0]).toContain("package.json");
    expect(r.failures[0]).not.toContain("package-lock.json");
    expect(r.skipped).toEqual([]);
  });

  it("names both files when both changed", () => {
    const r = run(
      report(),
      [allow],
      trees,
      TODAY,
      "b".repeat(64),
      "d".repeat(64),
    );
    expect(r.failures[0]).toContain("package.json and package-lock.json");
  });

  it("fails closed when npm ls reports a problem, even with a tree that parses", () => {
    for (const bad of [
      { ...inside, failed: true },
      { ...inside, problems: ["invalid: lib"] },
      { ...inside, error: { code: "ELSPROBLEMS" } },
    ])
      expect(run(report(), [allow], { lib: bad }).failures[0]).toContain(
        "npm ls reported a problem",
      );
  });

  it("fails closed when npm ls gives no installed path", () => {
    const pathless: LsNode = {
      dependencies: { auth: { dependencies: { lib: {} } } },
    };
    expect(run(report(), [allow], { lib: pathless }).failures[0]).toContain(
      "no installed path",
    );
  });

  it("fails when it can't find how the package reaches the site", () => {
    expect(run(report(), [allow], { lib: {} }).failures[0]).toContain(
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

  it("judges every reading of an allowed advisory, not just the first one listed", () => {
    // The same advisory under a second package, with a range nobody allowed.
    const lib = report().vulnerabilities?.lib as Vulnerability;
    const other: Vulnerability = {
      name: "other",
      via: [
        {
          url: URL,
          name: "lib",
          title: "ReDoS",
          severity: "high",
          range: "<=2.0.0",
        },
      ],
    };
    const r = run({ vulnerabilities: { lib, other } });
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain("<=2.0.0");
    // Listed the other way round, it fails the same.
    const flipped: AuditReport = { vulnerabilities: { other, lib } };
    expect(run(flipped).failures).toHaveLength(1);
  });

  it("fails readings of one advisory that disagree on severity, in either order", () => {
    // The same address, package and range, read as high in one place and
    // moderate in another: neither reading may stand for the other.
    const lib = report().vulnerabilities?.lib as Vulnerability;
    const other: Vulnerability = {
      name: "other",
      via: [
        {
          url: URL,
          name: "lib",
          title: "ReDoS",
          severity: "moderate",
          range: "<=1.0.0",
        },
      ],
    };
    for (const vulnerabilities of [
      { lib, other },
      { other, lib },
    ]) {
      const r = run({ vulnerabilities });
      expect(r.failures).toContain(
        `lib: ${URL} reads as high and moderate in different places, so it can't be judged.`,
      );
      expect(r.failures.some((f) => f.includes("is now moderate"))).toBe(true);
    }
    // Not allowed, and one reading high: fails the same way.
    expect(run({ vulnerabilities: { other, lib } }, []).failures).toContain(
      `lib: ${URL} reads as high and moderate in different places, so it can't be judged.`,
    );
    // Not allowed and nothing high: no failure over the disagreement.
    const low: Vulnerability = {
      name: "low",
      via: [{ ...(other.via[0] as object), severity: "low" } as never],
    };
    expect(run({ vulnerabilities: { other, low } }, []).failures).toEqual([]);
  });

  it("keeps an allowance only while its advisory shows for its own package", () => {
    // The same address now listed under another package: the allowance is
    // stale, and the other package's reading isn't covered by it.
    const r = run(
      {
        vulnerabilities: {
          elsewhere: {
            name: "elsewhere",
            via: [
              {
                url: URL,
                name: "elsewhere",
                title: "ReDoS",
                severity: "high",
                range: "<=1.0.0",
              },
            ],
          },
        },
      },
      [allow],
    );
    expect(r.failures).toContain(
      `${URL} no longer shows in the audit for lib: take its allowance out of scripts/check-audit.ts.`,
    );
    expect(
      r.failures.some((f) => f.startsWith("elsewhere: ReDoS (high)")),
    ).toBe(true);
  });

  it("knows it was run as a script through a symlinked checkout, and not when imported", () => {
    const dir = mkdtempSync(join(tmpdir(), "check-audit-"));
    const real = join(dir, "check-audit.ts");
    writeFileSync(real, "");
    const link = join(dir, "linked.ts");
    symlinkSync(real, link);
    expect(invokedAs(real, real)).toBe(true);
    expect(invokedAs(link, real)).toBe(true);
    expect(invokedAs(join(dir, "vitest.mjs"), real)).toBe(false);
    expect(invokedAs(undefined, real)).toBe(false);
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
        manifest: expect.stringMatching(/^[0-9a-f]{64}$/),
        lockfile: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    ]);
  });

  it("runs in CI in place of the bare npm audit", () => {
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(ci).toContain("scripts/check-audit.ts");
    expect(ci).not.toMatch(/run: npm audit/);
  });
});
