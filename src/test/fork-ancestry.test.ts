import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { checkPrAncestry } from "../../evals/agents/check-pr-ancestry";

let folder: string;
let root: string;
let intendedBase: string;
let currentHead: string;
let staleHead: string;
let unrelated: string;

function git(args: string[]): string {
  return execFileSync(
    "git",
    [
      "-C",
      folder,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "-c",
      "commit.gpgSign=false",
      ...args,
    ],
    { encoding: "utf8", input: "", stdio: ["pipe", "pipe", "pipe"] },
  ).trim();
}

beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), "pr-ancestry-"));
  git(["init", "--quiet"]);
  const tree = git(["mktree"]);
  const commit = (msg: string, parent?: string) =>
    git(["commit-tree", tree, "-m", msg, ...(parent ? ["-p", parent] : [])]);
  root = commit("shared root");
  const upstreamStep = commit("upstream step", root);
  intendedBase = commit("intended upstream base", upstreamStep);
  currentHead = commit("current contributor head", intendedBase);
  staleHead = commit("stale contributor head", root);
  unrelated = commit("unrelated root");
  // Neither result should depend on the fork's default branch.
  git(["update-ref", "refs/heads/main", root]);
});

afterAll(() => {
  if (folder) rmSync(folder, { recursive: true, force: true });
});

test("compares the actual contributor head to the intended upstream base", () => {
  expect(checkPrAncestry(folder, intendedBase, currentHead)).toEqual({
    status: "current",
    behind: 0,
  });
  expect(checkPrAncestry(folder, intendedBase, intendedBase)).toEqual({
    status: "current",
    behind: 0,
  });
});

test("counts only the intended base commits absent from contributor history", () => {
  expect(checkPrAncestry(folder, intendedBase, staleHead)).toEqual({
    status: "behind",
    behind: 2,
  });
});

test("does not treat unrelated history as a count or as current", () => {
  expect(checkPrAncestry(folder, intendedBase, unrelated)).toEqual({
    status: "unknown",
    reason: "unrelated",
  });
});

test("rejects missing commits and drifting refs rather than guessing", () => {
  expect(
    checkPrAncestry(folder, "f".repeat(intendedBase.length), currentHead),
  ).toEqual({
    status: "unknown",
    reason: "base",
  });
  expect(checkPrAncestry(folder, intendedBase, "HEAD")).toEqual({
    status: "unknown",
    reason: "head",
  });
});

test("refuses an incomplete shallow history", () => {
  const clone = join(folder, "shallow");
  git(["branch", "fixture", currentHead]);
  git([
    "clone",
    "--quiet",
    "--branch",
    "fixture",
    "--depth",
    "1",
    `file://${folder}`,
    clone,
  ]);
  expect(checkPrAncestry(clone, intendedBase, currentHead)).toEqual({
    status: "unknown",
    reason: "shallow",
  });
});
