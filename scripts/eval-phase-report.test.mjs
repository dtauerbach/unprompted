import assert from "node:assert/strict";
import { test } from "node:test";
import { reportEvalPhases } from "./eval-phase-report.mjs";

const head = "a".repeat(40);
const r = (run, ms, more = {}) => ({
  repo: "fixture/site",
  pr: 3,
  workflow: "Eval",
  suite: "full",
  instrumentation: "test-phase-v1",
  run,
  attempt: 1,
  status: "success",
  head,
  expected_head: head,
  finished_at: `2026-01-01T00:00:0${run}Z`,
  eval_phase_ms: ms,
  tests: 100,
  ...more,
});

test("odd and even medians stay in the test-phase column; selects latest N", () => {
  const sample = [r(1, 100), r(2, 550, { job_elapsed_ms: 660 }), r(3, 200)];
  assert.equal(reportEvalPhases(sample)[0].median_eval_phase_ms, 200);
  const [even] = reportEvalPhases(sample, 2);
  assert.equal(even.median_eval_phase_ms, 375);
  assert.deepEqual(
    even.samples.map((s) => s.run),
    [3, 2],
  );
  assert.equal(even.samples[1].job_elapsed_ms, 660);
});

test("missing, failed, cancelled, queued and mismatched heads aren't zeros", () => {
  const [out] = reportEvalPhases([
    r(1, null),
    r(2, 100, { status: "failed" }),
    r(3, 1, { status: "cancelled" }),
    r(4, 1, { status: "queued" }),
    r(5, 1, { head: "b".repeat(40) }),
  ]);
  assert.equal(out.median_eval_phase_ms, null);
  assert.equal(out.sample_count, 0);
  assert.deepEqual(out.omitted, {
    failed: 1,
    cancelled: 1,
    queued: 1,
    missing: 1,
    head_mismatch: 1,
  });
});

test("never pools suites/instrumentation; flags changed counts and uses latest attempt only", () => {
  const all = reportEvalPhases([
    r(1, 100),
    r(1, 110, { attempt: 2 }),
    r(2, 99, { tests: 101 }),
    r(3, 900, { suite: "short" }),
    r(4, 900, { instrumentation: "other" }),
  ]);
  assert.equal(all.length, 3);
  const full = all.find(
    (o) => o.suite === "full" && o.instrumentation === "test-phase-v1",
  );
  assert.equal(full.sample_count, 2);
  assert.equal(full.test_counts_changed, true);
  assert.equal(full.samples[1].attempt, 2);
  assert.throws(() => reportEvalPhases([r(1, 100), r(1, 101)]), /Duplicate/);
});
