// Fails CI on any high or critical advisory in what the site installs for
// production, as `npm audit --omit=dev --audit-level=high` did, except an
// advisory listed in ALLOWED below. An allowance holds only while the
// advisory still reads exactly as it did when it was allowed (the same
// severity and affected range), every route to its package in the production
// tree still runs through the dependency chain it names, and its review date
// hasn't passed. Anything else fails CI until the allowance is looked at
// again: a fix (a changed range), a reclassification either way, a new route
// in, or the date. An allowance whose advisory no longer shows fails too, so
// it gets taken out. CI runs it on every push:
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
  // Its severity and affected range when it was allowed.
  severity: string;
  range: string;
  // The chain of packages from the site's own dependencies that every route
  // to `name` in the production tree must start with.
  through: string[];
  // After this day (UTC) the allowance fails until someone looks again.
  reviewBy: string;
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
    severity: "high",
    range: "<=4.0.7",
    through: ["@neondatabase/auth", "better-auth", "vitest"],
    reviewBy: "2026-12-17",
    why: "ReDoS reached only through a test runner; no fix released yet",
  },
];

type Advisory = {
  url: string;
  name: string;
  title: string;
  severity: string;
  range: string;
};
type Vulnerability = { name: string; via: (string | Advisory)[] };
export type AuditReport = { vulnerabilities?: Record<string, Vulnerability> };

// `npm ls <name> --omit=dev --all --json`: the production tree, cut to the
// routes that reach <name>. A package npm has already shown elsewhere is
// listed again without its children (deduped).
export type LsNode = { dependencies?: Record<string, LsNode> };

// Every route from the site to `target`, as package names. A deduped package
// that leads to `target` somewhere else in the tree ends a route too, so a
// new route through an already-listed package isn't missed.
export function routesTo(tree: LsNode, target: string): string[][] {
  const carriers = new Set<string>();
  const full: string[][] = [];
  const walk = (n: LsNode, path: string[]) => {
    for (const [k, v] of Object.entries(n.dependencies ?? {})) {
      const p = [...path, k];
      if (k === target) full.push(p);
      else walk(v, p);
    }
  };
  walk(tree, []);
  for (const p of full) for (const k of p.slice(0, -1)) carriers.add(k);
  const routes: string[][] = [];
  const ends = (n: LsNode, path: string[]) => {
    for (const [k, v] of Object.entries(n.dependencies ?? {})) {
      const p = [...path, k];
      const kids = Object.keys(v.dependencies ?? {}).length;
      if (k === target || (carriers.has(k) && kids === 0)) routes.push(p);
      else ends(v, p);
    }
  };
  ends(tree, []);
  return routes;
}

const SERIOUS = new Set(["high", "critical"]);

export function judge(
  report: AuditReport,
  allowed: Allowance[],
  trees: Record<string, LsNode>,
  today: string,
): { failures: string[]; skipped: string[] } {
  const seen = new Map<string, Advisory>();
  for (const v of Object.values(report.vulnerabilities ?? {}))
    for (const a of v.via)
      if (typeof a !== "string" && !seen.has(a.url)) seen.set(a.url, a);
  const failures: string[] = [];
  const skipped: string[] = [];
  const fix =
    "Look at it again, then update or take out its allowance in scripts/check-audit.ts.";
  for (const a of seen.values()) {
    const allow = allowed.find((x) => x.url === a.url && x.name === a.name);
    if (!allow) {
      if (SERIOUS.has(a.severity))
        failures.push(`${a.name}: ${a.title} (${a.severity}) ${a.url}`);
      continue;
    }
    // An allowed advisory is judged whatever its severity now, so a drop
    // below high fails as surely as a rise to critical.
    if (a.severity !== allow.severity) {
      failures.push(
        `${a.name}: ${a.url} is now ${a.severity}, not ${allow.severity}. ${fix}`,
      );
      continue;
    }
    if (a.range !== allow.range) {
      failures.push(
        `${a.name}: ${a.url} now affects ${a.range}, not ${allow.range}, so a fix may be out. ${fix}`,
      );
      continue;
    }
    if (today > allow.reviewBy) {
      failures.push(
        `${a.name}: ${a.url} was allowed until ${allow.reviewBy}. ${fix}`,
      );
      continue;
    }
    const routes = routesTo(trees[a.name] ?? {}, a.name);
    const outside = routes.filter(
      (r) =>
        r.length < allow.through.length ||
        allow.through.some((k, i) => r[i] !== k),
    );
    if (!routes.length || outside.length) {
      failures.push(
        routes.length
          ? `${a.name}: ${a.url} now also reaches the site through ${outside.map((r) => r.join(" > ")).join("; ")}, which its allowance doesn't cover.`
          : `${a.name}: ${a.url}: couldn't find how it reaches the site, so its allowance can't be checked.`,
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

// npm audit and npm ls exit non-zero when they find something; their report
// is still on stdout.
function npmJson(args: string[]): unknown {
  let out: string;
  try {
    out = execFileSync("npm", args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    out = (e as { stdout?: string }).stdout ?? "";
  }
  return JSON.parse(out);
}

const invoked =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  let report: AuditReport;
  const trees: Record<string, LsNode> = {};
  try {
    report = npmJson(["audit", "--omit=dev", "--json"]) as AuditReport;
    for (const name of new Set(ALLOWED.map((a) => a.name)))
      trees[name] = npmJson([
        "ls",
        name,
        "--omit=dev",
        "--all",
        "--json",
      ]) as LsNode;
  } catch {
    console.error("::error::npm audit or npm ls gave no report.");
    process.exit(1);
  }
  if ((report as { error?: unknown }).error || !report.vulnerabilities) {
    console.error("::error::npm audit couldn't check the dependencies.");
    process.exit(1);
  }
  const today = new Date().toISOString().slice(0, 10);
  const { failures, skipped } = judge(report, ALLOWED, trees, today);
  for (const s of skipped) console.log(`Allowed for now: ${s}`);
  if (failures.length) {
    for (const f of failures) console.error(`::error::${f}`);
    process.exit(1);
  }
  console.log("No high or critical advisory beyond the ones allowed.");
}
