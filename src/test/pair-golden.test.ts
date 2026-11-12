import { readFileSync, writeFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "./helpers";
import { pairScenario } from "./pair-golden";

// Before and after: today's answers to everything a pair does are the ones
// recorded before pairs became private channels of two (see pair-golden.ts).
// The fixture was recorded on the code of #113 (pairing on an ask), before
// 047. Re-record it only on purpose, from a checkout whose pair behaviour is
// the one to hold: PAIR_GOLDEN_RECORD=1 npx vitest run src/test/pair-golden.test.ts
// writes it and passes; anything else compares.

beforeEach(resetDb);

describe("pairs as private channels of two", () => {
  it("answer every call exactly as before", async () => {
    const before = JSON.parse(
      readFileSync("src/test/fixtures/pair-golden.json", "utf8"),
    );
    const after = await pairScenario();
    if (process.env.PAIR_GOLDEN_RECORD === "1") {
      writeFileSync(
        "src/test/fixtures/pair-golden.json",
        `${JSON.stringify(after, null, 2)}\n`,
      );
      return;
    }
    expect(after.map((s) => s.step)).toEqual(
      before.map((s: { step: string }) => s.step),
    );
    for (const [i, s] of after.entries()) expect(s).toEqual(before[i]);
  });
});
