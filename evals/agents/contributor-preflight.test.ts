import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ContributorEvidence,
  contributorPreflight,
  type PreflightTarget,
} from "./contributor-preflight";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const target: PreflightTarget = {
  identity: "fixture-agent",
  upstream: { repository: "fixture/upstream", branch: "main" },
  fork: { repository: "fixture/fork", branch: "preflight" },
  submittedHead: headSha,
};

function receipts(): ContributorEvidence {
  return {
    upstreamRead: {
      state: "observed",
      receipt: { ...target.upstream, sha: baseSha },
    },
    forkWrite: {
      state: "observed",
      receipt: {
        ...target.fork,
        parentRepository: target.upstream.repository,
        identity: target.identity,
        sha: headSha,
      },
    },
    prCreation: { state: "observed", receipt: true },
    prLookup: {
      state: "observed",
      receipt: {
        number: 42,
        base: { ...target.upstream, sha: baseSha },
        head: { ...target.fork, sha: headSha },
        headParentRepository: target.upstream.repository,
      },
    },
  };
}

test("matching synthetic receipts exercise all four stages but never certify a live run", () => {
  assert.deepEqual(contributorPreflight(target, receipts()), {
    scope: "fixture_only",
    upstreamRead: "verified",
    forkWrite: "verified",
    prCreation: "exposed",
    forkPr: "verified",
  });
});

test("unsupported operations, refused operations, and unattempted steps stay distinct", () => {
  assert.deepEqual(
    contributorPreflight(target, {
      upstreamRead: { state: "denied" },
      forkWrite: { state: "unsupported" },
      prCreation: { state: "unsupported" },
    }),
    {
      scope: "fixture_only",
      upstreamRead: "denied",
      forkWrite: "unsupported",
      prCreation: "unsupported",
      forkPr: "unverified",
    },
  );
  assert.equal(
    contributorPreflight(target, { forkWrite: { state: "denied" } }).forkWrite,
    "denied",
  );
});

test("read access and tool exposure establish neither fork writes nor a PR", () => {
  const { upstreamRead, prCreation } = receipts();
  assert.deepEqual(contributorPreflight(target, { upstreamRead, prCreation }), {
    scope: "fixture_only",
    upstreamRead: "verified",
    forkWrite: "unverified",
    prCreation: "exposed",
    forkPr: "unverified",
  });
});

test("same-repo branch never passes the fork stages", () => {
  const sameRepo = {
    ...target,
    fork: { ...target.fork, repository: target.upstream.repository },
  };
  const evidence = receipts();
  if (evidence.forkWrite?.state === "observed")
    evidence.forkWrite.receipt.repository = sameRepo.fork.repository;
  if (evidence.prLookup?.state === "observed")
    evidence.prLookup.receipt.head.repository = sameRepo.fork.repository;
  const result = contributorPreflight(sameRepo, evidence);
  assert.equal(result.forkWrite, "mismatch");
  assert.equal(result.forkPr, "mismatch");
});

test("a write receipt from a different identity, branch, parent, or head does not count", () => {
  for (const patch of [
    { identity: "other-agent" },
    { branch: "another-branch" },
    { parentRepository: "fixture/unrelated" },
    { sha: baseSha },
  ]) {
    const evidence = receipts();
    if (evidence.forkWrite?.state === "observed")
      Object.assign(evidence.forkWrite.receipt, patch);
    assert.equal(contributorPreflight(target, evidence).forkWrite, "mismatch");
  }
});

test("a PR for a different repository, base branch, or submitted head does not count", () => {
  for (const edit of [
    { base: { ...target.upstream, branch: "develop", sha: baseSha } },
    { head: { ...target.fork, repository: "fixture/other", sha: headSha } },
    { head: { ...target.fork, sha: baseSha } },
    { headParentRepository: "fixture/unrelated" },
    { number: 0 },
  ]) {
    const evidence = receipts();
    if (evidence.prLookup?.state === "observed")
      Object.assign(evidence.prLookup.receipt, edit);
    assert.equal(contributorPreflight(target, evidence).forkPr, "mismatch");
  }
});

test("a PR read can verify the PR without proving who could write its fork", () => {
  const { prLookup } = receipts();
  const result = contributorPreflight(target, { prLookup });
  assert.equal(result.forkPr, "verified");
  assert.equal(result.forkWrite, "unverified");
});

test("a ref read for another branch or a short hash does not count", () => {
  for (const observed of [
    { ...target.upstream, branch: "develop", sha: baseSha },
    { ...target.upstream, sha: "abc123" },
  ]) {
    assert.equal(
      contributorPreflight(target, {
        upstreamRead: { state: "observed", receipt: observed },
      }).upstreamRead,
      "mismatch",
    );
  }
});
