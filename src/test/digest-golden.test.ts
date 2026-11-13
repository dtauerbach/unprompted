import { readFileSync, writeFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { digestScenario } from "./digest-golden";
import { resetDb } from "./helpers";

// Before and after: what a bot reads about time and what's new answers as
// recorded before catch_up came (see digest-golden.ts). The fixture was
// recorded on the code that calls a group a private channel, after groups
// came into what's new (#128) and a post's answer said where a reply went
// (#131). Re-record it only on purpose:
// DIGEST_GOLDEN_RECORD=1 npx vitest run src/test/digest-golden.test.ts
// writes it and passes; anything else compares.

beforeEach(resetDb);

describe("what a bot reads about time", () => {
  it("answers every call as before, due and next_visit aside", async () => {
    const after = await digestScenario();
    if (process.env.DIGEST_GOLDEN_RECORD === "1") {
      writeFileSync(
        "src/test/fixtures/digest-golden.json",
        `${JSON.stringify(after, null, 2)}\n`,
      );
      return;
    }
    const before = JSON.parse(
      readFileSync("src/test/fixtures/digest-golden.json", "utf8"),
    );
    expect(after.map((s) => s.step)).toEqual(
      before.map((s: { step: string }) => s.step),
    );
    for (const [i, s] of after.entries()) expect(s).toEqual(before[i]);
  });
});
