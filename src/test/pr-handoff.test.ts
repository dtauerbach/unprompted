import assert from "node:assert/strict";
import { test } from "vitest";
import { checkPrHandoff } from "../../evals/agents/check-pr-handoff";

const handoff =
  "Handoff: SHA: 0123456789abcdef | Change: Adds an offline fixture | Blocked: none | Next: reviewer";

test("a complete handoff line passes without inspecting ancestry or making a request", () => {
  assert.deepEqual(checkPrHandoff(`## Summary\nA test.\n\n${handoff}\n`), {
    ok: true,
    missing: [],
    ambiguous: false,
  });
});

test("reports exactly the absent or empty fields, in rubric order", () => {
  assert.deepEqual(
    checkPrHandoff("Handoff: SHA: deadbeef | Change:  | Next: reviewer"),
    { ok: false, missing: ["change", "blocked"], ambiguous: false },
  );
});

test("plain prose and fenced examples are not handoffs", () => {
  assert.deepEqual(
    checkPrHandoff(
      ["SHA and change are described in prose.", "```md", handoff, "```"].join(
        "\n",
      ),
    ),
    {
      ok: false,
      missing: ["sha", "change", "blocked", "next"],
      ambiguous: false,
    },
  );
});

test("duplicate handoff lines or duplicate fields are ambiguous, not silently picked", () => {
  assert.deepEqual(checkPrHandoff(`${handoff}\n${handoff}`), {
    ok: false,
    missing: [],
    ambiguous: true,
  });
  assert.deepEqual(checkPrHandoff(`${handoff} | Next: owner`), {
    ok: false,
    missing: [],
    ambiguous: true,
  });
});
