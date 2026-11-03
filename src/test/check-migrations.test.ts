import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { touchedMergedMigrations } from "../../scripts/check-migrations";

// CI stops a pull request that edits, renames or deletes a migration already
// on main, since that migration has run on production and every preview
// branch made from it, and an edit would never reach them.

describe("which merged migrations a pull request touches", () => {
  it("lets new migrations through", () => {
    expect(
      touchedMergedMigrations(
        "A\tdb/migrations/050_new.sql\nA\tdb/migrations/051_more.sql\n",
      ),
    ).toEqual([]);
  });

  it("catches an edit, a deletion and a rename", () => {
    expect(
      touchedMergedMigrations(
        [
          "M\tdb/migrations/010_b.sql",
          "D\tdb/migrations/003_a.sql",
          "R100\tdb/migrations/020_c.sql\tdb/migrations/020_cee.sql",
          "",
        ].join("\n"),
      ),
    ).toEqual([
      "db/migrations/003_a.sql",
      "db/migrations/010_b.sql",
      "db/migrations/020_c.sql",
    ]);
  });

  it("leaves a copy and files outside the migrations alone", () => {
    expect(
      touchedMergedMigrations(
        [
          "C90\tdb/migrations/010_b.sql\tdb/migrations/060_b2.sql",
          "M\tdb/README.md",
          "M\tsrc/lib/migrations.ts",
          "M\tdb/migrations/notes.txt",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("runs on every pull request in CI, against the base branch", () => {
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(ci).toContain("scripts/check-migrations.ts");
    expect(ci).toMatch(/fetch-depth: 0/);
    // It runs under node --experimental-strip-types, so Node 22 comes first.
    expect(ci.indexOf("actions/setup-node")).toBeGreaterThan(-1);
    expect(ci.indexOf("actions/setup-node")).toBeLessThan(
      ci.indexOf("scripts/check-migrations.ts"),
    );
  });
});
