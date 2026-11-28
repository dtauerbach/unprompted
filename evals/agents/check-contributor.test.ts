import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("./check-contributor.ts", import.meta.url));
const tsx = import.meta.resolve("tsx");

function withRepo(run: (dir: string, root: string, tip: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "contributor-command-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  const commit = (message: string) => {
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-qm",
      message,
    );
    return git("rev-parse", "HEAD");
  };
  try {
    git("init", "-qb", "main");
    const root = commit("base");
    run(dir, root, commit("tip"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function fixture(base: string, head: string) {
  const upstream = { repository: "fixture/upstream", branch: "main" };
  const fork = { repository: "fixture/fork", branch: "entry" };
  const identity = "fixture-bot";
  return {
    target: { identity, upstream, fork, submittedHead: head },
    evidence: {
      upstreamRead: { state: "observed", receipt: { ...upstream, sha: base } },
      forkWrite: {
        state: "observed",
        receipt: {
          ...fork,
          identity,
          parentRepository: upstream.repository,
          sha: head,
        },
      },
      prCreation: { state: "observed", receipt: true },
      prLookup: {
        state: "observed",
        receipt: {
          number: 5,
          base: { ...upstream, sha: base },
          head: { ...fork, sha: head },
          headParentRepository: upstream.repository,
        },
      },
    },
    description: `Handoff: SHA: ${head} | Change: fixture | Blocked: none | Next: reviewer`,
    base,
  };
}

function command(dir: string, input: unknown) {
  const result = spawnSync(process.execPath, ["--import", tsx, cli], {
    cwd: dir,
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.trim().split("\n").length, 1);
  return { status: result.status, report: JSON.parse(result.stdout) };
}

test("reports all three passing checks but never labels the run a live pass", () =>
  withRepo((dir, base, head) => {
    const { status, report } = command(dir, fixture(base, head));
    assert.equal(status, 0);
    assert.equal(report.scope, "offline");
    assert.equal(report.evidence.scope, "fixture_only");
    assert.equal(report.evidence.forkPr, "verified");
    assert.equal(report.handoff.ok, true);
    assert.deepEqual(report.ancestry, { status: "current", behind: 0 });
  }));

test("keeps a failed handoff and stale head together in one report", () =>
  withRepo((dir, root, tip) => {
    const input = fixture(tip, root);
    input.description = "Handoff: SHA: fixture | Change: fixture";
    const { status, report } = command(dir, input);
    assert.equal(status, 1);
    assert.deepEqual(report.handoff.missing, ["blocked", "next"]);
    assert.deepEqual(report.ancestry, { status: "behind", behind: 1 });
  }));

test("distinguishes incomplete offline evidence and unknown ancestry from a pass", () =>
  withRepo((dir, base) => {
    const input = fixture(base, "a".repeat(40));
    const { status, report } = command(dir, { ...input, evidence: {} });
    assert.equal(status, 2);
    assert.equal(report.evidence.forkPr, "unverified");
    assert.deepEqual(report.ancestry, { status: "unknown", reason: "head" });
  }));

test("returns one safe report for malformed input, without echoing its body", () =>
  withRepo((dir) => {
    assert.deepEqual(command(dir, "{not-json}, private fixture"), {
      status: 2,
      report: { scope: "offline", error: "invalid_input" },
    });
  }));
