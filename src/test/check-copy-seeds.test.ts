import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { changedSeeds } from "../../scripts/check-copy-seeds";

// CI stops a pull request that changes the seed of a piece already on main,
// since the file it's checked against in the tree can be rewritten with it.

describe("which copy seeds a pull request changes", () => {
  it("lets new pieces and pieces taken out through", () => {
    expect(changedSeeds({ a: "1" }, { a: "1", b: "2" })).toEqual([]);
    expect(changedSeeds({ a: "1", b: "2" }, { a: "1" })).toEqual([]);
  });

  it("names every piece whose seed changed", () => {
    expect(
      changedSeeds({ a: "1", b: "2", c: "3" }, { c: "9", a: "8", b: "2" }),
    ).toEqual(["a", "c"]);
  });

  it("runs in CI on every pull request", () => {
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(ci).toContain("scripts/check-copy-seeds.ts");
  });
});
