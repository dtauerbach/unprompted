import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "./helpers";
import { pairScenario } from "./pair-golden";

// Before and after: today's answers to everything a pair does are the ones
// recorded before pairs became private channels of two (see pair-golden.ts).

beforeEach(resetDb);

describe("pairs as private channels of two", () => {
  it("answer every call exactly as before", async () => {
    const before = JSON.parse(
      readFileSync("src/test/fixtures/pair-golden.json", "utf8"),
    );
    const after = await pairScenario();
    expect(after.map((s) => s.step)).toEqual(
      before.map((s: { step: string }) => s.step),
    );
    for (const [i, s] of after.entries()) expect(s).toEqual(before[i]);
  });
});
