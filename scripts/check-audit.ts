// Fails CI on any high or critical advisory in what the site installs for
// production, as `npm audit --omit=dev --audit-level=high` did, except an
// advisory listed in ALLOWED below. An allowance holds only while the
// advisory still reads exactly as it did when it was allowed (the same
// severity and affected range), package.json and package-lock.json are the
// ones reviewed, every route to its package in the production tree still runs
// through the dependency chain it names, and its review date hasn't passed.
// Anything else fails CI until the allowance is looked at again: a fix (a
// changed range), a reclassification either way, a changed manifest or
// lockfile, a new route in, a tree npm reports a problem with, or the date.
// The route walk is a cross-check of the pinned tree, not proof of what the
// site reaches at runtime: that was judged by hand when it was allowed. An allowance whose advisory no longer
// shows fails too, so it gets taken out. CI runs it on every push:
//
//   node --experimental-strip-types scripts/check-audit.ts
//
// Plain Node, no dependencies.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
  // SHA-256 of package.json and of package-lock.json as reviewed. Any change
  // to either fails until someone checks the tree again and updates them
  // (npm ci checks the two agree, not that they're the ones reviewed).
  manifest: string;
  lockfile: string;
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
    manifest:
      "153f8fa4130044b9223e4a73b9ee737ede6fd43d74912cf752dae1d94b70d564",
    lockfile:
      "7a8a9f59020da632455d41d60bc2736ec4d739c4f47dc728bc92ccc8550c0049",
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

// `npm ls <name> --omit=dev --all --long --json`: the production tree, cut
// to the routes that reach <name>, each package with its installed path. A
// package npm has already shown elsewhere is listed again without its
// children (deduped), so routes are rebuilt by installed path, never by name,
// and two installed copies of one package stay apart. `problems` or `error`,
// or npm exiting non-zero (`failed`, set by the caller), means the tree can't
// be trusted.
export type LsNode = {
  path?: string;
  dependencies?: Record<string, LsNode>;
  problems?: unknown;
  error?: unknown;
  failed?: boolean;
};

// Every route from the site to `target`, as package names, from npm's view of
// the pinned tree: a cross-check of how a package is installed, not of what
// code runs. A deduped package
// whose installed copy leads to `target` somewhere else in the tree ends a
// route too, so a new route through an already-listed package isn't missed.
// A package without an installed path throws: the routes can't be told apart.
export function routesTo(tree: LsNode, target: string): string[][] {
  const at = (n: LsNode, name: string) => {
    if (!n.path) throw new Error(`npm ls gave no installed path for ${name}`);
    return n.path;
  };
  const carriers = new Set<string>();
  const walk = (n: LsNode): boolean => {
    let leads = false;
    for (const [k, v] of Object.entries(n.dependencies ?? {})) {
      const here = at(v, k);
      if (k === target || walk(v)) {
        leads = true;
        if (k !== target) carriers.add(here);
      }
    }
    return leads;
  };
  walk(tree);
  const routes: string[][] = [];
  const ends = (n: LsNode, names: string[]) => {
    for (const [k, v] of Object.entries(n.dependencies ?? {})) {
      const p = [...names, k];
      const kids = Object.keys(v.dependencies ?? {}).length;
      if (k === target || (kids === 0 && carriers.has(at(v, k))))
        routes.push(p);
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
  files: { manifest: string; lockfile: string },
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
    const changed = (
      [
        ["package.json", "manifest"],
        ["package-lock.json", "lockfile"],
      ] as const
    ).filter(([, k]) => files[k] !== allow[k]);
    if (changed.length) {
      failures.push(
        `${a.name}: ${a.url} was allowed for ${changed.map(([f, k]) => `${f} ${allow[k].slice(0, 12)}, and it's now ${files[k].slice(0, 12)}`).join("; ")}. Check every route to ${a.name} again (npm ls ${a.name} --omit=dev --all), then put the new sha256sum of ${changed.map(([f]) => f).join(" and ")} in its allowance in scripts/check-audit.ts.`,
      );
      continue;
    }
    const tree = trees[a.name];
    if (!tree || tree.failed || tree.problems || tree.error) {
      failures.push(
        `${a.name}: ${a.url}: npm ls reported a problem with the tree, so its allowance can't be checked.`,
      );
      continue;
    }
    let routes: string[][];
    try {
      routes = routesTo(tree, a.name);
    } catch (e) {
      failures.push(`${a.name}: ${a.url}: ${(e as Error).message}.`);
      continue;
    }
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

// npm audit exits non-zero when it finds something, and its report is still
// on stdout; `ok` says whether it exited zero.
function npmJson(args: string[]): { json: unknown; ok: boolean } {
  try {
    const out = execFileSync("npm", args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return { json: JSON.parse(out), ok: true };
  } catch (e) {
    return {
      json: JSON.parse((e as { stdout?: string }).stdout ?? ""),
      ok: false,
    };
  }
}

const invoked =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  let report: AuditReport;
  const trees: Record<string, LsNode> = {};
  try {
    report = npmJson(["audit", "--omit=dev", "--json"]).json as AuditReport;
    for (const name of new Set(ALLOWED.map((a) => a.name))) {
      const ls = npmJson([
        "ls",
        name,
        "--omit=dev",
        "--all",
        "--long",
        "--json",
      ]);
      trees[name] = { ...(ls.json as LsNode), failed: !ls.ok };
    }
  } catch {
    console.error("::error::npm audit or npm ls gave no report.");
    process.exit(1);
  }
  if ((report as { error?: unknown }).error || !report.vulnerabilities) {
    console.error("::error::npm audit couldn't check the dependencies.");
    process.exit(1);
  }
  const today = new Date().toISOString().slice(0, 10);
  const sha = (f: string) =>
    createHash("sha256").update(readFileSync(f)).digest("hex");
  const { failures, skipped } = judge(report, ALLOWED, trees, today, {
    manifest: sha("package.json"),
    lockfile: sha("package-lock.json"),
  });
  for (const s of skipped) console.log(`Allowed for now: ${s}`);
  if (failures.length) {
    for (const f of failures) console.error(`::error::${f}`);
    process.exit(1);
  }
  console.log("No high or critical advisory beyond the ones allowed.");
}
