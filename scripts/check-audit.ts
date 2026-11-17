// Fails CI on any high or critical advisory in what the site installs for
// production, as `npm audit --omit=dev --audit-level=high` did, except an
// advisory listed in ALLOWED below. An allowance holds only while the
// advisory still reads as it did when it was allowed (the same affected
// range, reached only through the same packages), so a fixed release, or a
// new package that starts pulling the library in, ends it and CI fails until
// the allowance is looked at again. An allowance whose advisory no longer
// shows fails too, so it gets taken out. CI runs it on every push:
//
//   node --experimental-strip-types scripts/check-audit.ts
//
// Plain Node, no dependencies.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export type Allowance = {
  // The advisory's address, as npm audit gives it.
  url: string;
  // The package it's about.
  name: string;
  // The affected range when it was allowed. A fix changes it.
  range: string;
  // Every package it reached through when it was allowed.
  effects: string[];
  why: string;
};

// GHSA-fc5q-39xc-vjpf: a ReDoS in picomatch (denial of service only, no code
// execution or data exposure), triggered by a glob pattern an attacker
// supplies. No fixed release exists yet. picomatch reaches the production
// tree only through vitest, an optional peer of better-auth (under
// @neondatabase/auth) that only better-auth's own test helpers import; the
// site never imports picomatch or passes it a pattern. Allowed on the
// maintainer's word, Nov 17, 2026, until a fixed picomatch ships: take this
// out then and update picomatch.
export const ALLOWED: Allowance[] = [
  {
    url: "https://github.com/advisories/GHSA-fc5q-39xc-vjpf",
    name: "picomatch",
    range: "<=4.0.7",
    effects: ["fdir", "tinyglobby", "vite", "vitest"],
    why: "ReDoS in a test runner's dependency; no fix released yet",
  },
];

type Advisory = {
  url: string;
  name: string;
  title: string;
  severity: string;
  range: string;
};
type Vulnerability = {
  name: string;
  via: (string | Advisory)[];
  effects: string[];
};
export type AuditReport = { vulnerabilities?: Record<string, Vulnerability> };

const SERIOUS = new Set(["high", "critical"]);

export function judge(
  report: AuditReport,
  allowed: Allowance[],
): { failures: string[]; skipped: string[] } {
  const vulns = report.vulnerabilities ?? {};
  const seen = new Map<string, Advisory>();
  for (const v of Object.values(vulns))
    for (const a of v.via)
      if (typeof a !== "string" && !seen.has(a.url)) seen.set(a.url, a);
  const failures: string[] = [];
  const skipped: string[] = [];
  for (const a of seen.values()) {
    if (!SERIOUS.has(a.severity)) continue;
    const allow = allowed.find((x) => x.url === a.url && x.name === a.name);
    if (!allow) {
      failures.push(`${a.name}: ${a.title} (${a.severity}) ${a.url}`);
      continue;
    }
    if (a.range !== allow.range) {
      failures.push(
        `${a.name}: ${a.url} now affects ${a.range}, not ${allow.range}, so a fix may be out. Update ${a.name} and take its allowance out of scripts/check-audit.ts.`,
      );
      continue;
    }
    const extra = (vulns[a.name]?.effects ?? []).filter(
      (e) => !allow.effects.includes(e),
    );
    if (extra.length) {
      failures.push(
        `${a.name}: ${a.url} now also reaches the site through ${extra.join(", ")}, which its allowance doesn't cover.`,
      );
      continue;
    }
    skipped.push(`${a.name}: ${a.url} (${allow.why})`);
  }
  for (const allow of allowed)
    if (!seen.has(allow.url))
      failures.push(
        `${allow.url} no longer shows in the audit: take its allowance out of scripts/check-audit.ts.`,
      );
  return { failures, skipped };
}

const invoked =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  let out: string;
  try {
    out = execFileSync("npm", ["audit", "--omit=dev", "--json"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    // npm audit exits non-zero when it finds anything; its report is still
    // on stdout. No report at all is a failure.
    out = (e as { stdout?: string }).stdout ?? "";
  }
  let report: AuditReport;
  try {
    report = JSON.parse(out) as AuditReport;
  } catch {
    console.error("::error::npm audit gave no report.");
    process.exit(1);
  }
  if ((report as { error?: unknown }).error || !report.vulnerabilities) {
    console.error("::error::npm audit couldn't check the dependencies.");
    process.exit(1);
  }
  const { failures, skipped } = judge(report, ALLOWED);
  for (const s of skipped) console.log(`Allowed for now: ${s}`);
  if (failures.length) {
    for (const f of failures) console.error(`::error::${f}`);
    process.exit(1);
  }
  console.log("No high or critical advisory beyond the ones allowed.");
}
