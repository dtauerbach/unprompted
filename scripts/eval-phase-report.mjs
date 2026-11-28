// Usage: node scripts/eval-phase-report.mjs records.json [limit]
// Input is recorded evidence, never a live API. Fields per record:
// repo, pr, workflow, suite, instrumentation, run, attempt, status, head,
// expected_head, finished_at, tests, eval_phase_ms, optional job_elapsed_ms.
// Group by benchmark contract; latest attempt replaces prior attempts.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const sha = /^[0-9a-f]{40}$/;
const statusNames = new Set([
  "success",
  "failed",
  "cancelled",
  "queued",
  "missing",
]);

export function reportEvalPhases(records, limit = 5) {
  if (
    !Array.isArray(records) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new TypeError("Expected an array and a sample limit from 1 to 100.");
  const groups = new Map();
  const seenAttempts = new Set();
  for (const r of records) {
    if (
      !r ||
      typeof r !== "object" ||
      ![r.repo, r.workflow, r.suite, r.instrumentation].every(
        (v) => typeof v === "string" && v.length > 0,
      ) ||
      !Number.isSafeInteger(r.pr) ||
      r.pr < 1 ||
      !Number.isSafeInteger(r.run) ||
      r.run < 1 ||
      !Number.isSafeInteger(r.attempt) ||
      r.attempt < 1 ||
      !statusNames.has(r.status)
    )
      throw new TypeError("A record is missing its run identity or status.");
    const key = JSON.stringify([
      r.repo,
      r.pr,
      r.workflow,
      r.suite,
      r.instrumentation,
    ]);
    const attemptKey = JSON.stringify([key, r.run, r.attempt]);
    if (seenAttempts.has(attemptKey))
      throw new TypeError("Duplicate run attempt.");
    seenAttempts.add(attemptKey);
    if (!groups.has(key)) groups.set(key, new Map());
    const group = groups.get(key);
    const prev = group.get(r.run);
    if (!prev || r.attempt > prev.attempt) group.set(r.run, r);
  }
  const results = [];
  for (const [key, group] of groups) {
    const [repo, pr, workflow, suite, instrumentation] = JSON.parse(key);
    const omitted = {
      failed: 0,
      cancelled: 0,
      queued: 0,
      missing: 0,
      head_mismatch: 0,
    };
    const eligible = [];
    for (const r of group.values()) {
      if (r.status !== "success") {
        omitted[r.status]++;
        continue;
      }
      if (
        !sha.test(r.head) ||
        !sha.test(r.expected_head) ||
        r.head !== r.expected_head
      ) {
        omitted.head_mismatch++;
        continue;
      }
      if (
        !Number.isSafeInteger(r.eval_phase_ms) ||
        r.eval_phase_ms <= 0 ||
        !Number.isSafeInteger(r.tests) ||
        r.tests <= 0 ||
        !Number.isFinite(Date.parse(r.finished_at))
      ) {
        omitted.missing++;
        continue;
      }
      eligible.push(r);
    }
    eligible.sort(
      (a, b) =>
        Date.parse(b.finished_at) - Date.parse(a.finished_at) || b.run - a.run,
    );
    const selected = eligible.slice(0, limit);
    const samples = selected.map((r) => ({
      run: r.run,
      attempt: r.attempt,
      head: r.head,
      tests: r.tests,
      eval_phase_ms: r.eval_phase_ms,
      ...(Number.isSafeInteger(r.job_elapsed_ms) &&
      r.job_elapsed_ms >= r.eval_phase_ms
        ? { job_elapsed_ms: r.job_elapsed_ms }
        : {}),
    }));
    const times = samples.map((s) => s.eval_phase_ms).sort((a, b) => a - b);
    const k = Math.floor(times.length / 2);
    const median =
      times.length === 0
        ? null
        : times.length % 2
          ? times[k]
          : times[k - 1] + (times[k] - times[k - 1]) / 2;
    results.push({
      repo,
      pr,
      workflow,
      suite,
      instrumentation,
      sample_count: samples.length,
      test_counts_changed: new Set(samples.map((s) => s.tests)).size > 1,
      median_eval_phase_ms: median,
      min_eval_phase_ms: times[0] ?? null,
      max_eval_phase_ms: times.at(-1) ?? null,
      samples,
      omitted,
    });
  }
  return results.sort((a, b) =>
    JSON.stringify([
      a.repo,
      a.pr,
      a.workflow,
      a.suite,
      a.instrumentation,
    ]).localeCompare(
      JSON.stringify([b.repo, b.pr, b.workflow, b.suite, b.instrumentation]),
    ),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const input = readFileSync(process.argv[2] ?? 0, "utf8");
    console.log(
      JSON.stringify(
        reportEvalPhases(
          JSON.parse(input),
          process.argv[3] === undefined ? 5 : Number(process.argv[3]),
        ),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid input.");
    process.exitCode = 1;
  }
}
