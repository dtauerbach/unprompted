import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COPY } from "@/lib/copy";
import { seedHash } from "@/lib/copy-seeds";

// The copy store is the one source of the words people read. The code keeps
// a seed for each piece, shown only until someone saves a version at
// /admin/copy, and a seed never changes once its piece exists: otherwise a
// pull request could change words the store already holds, or change words
// on the live site behind the store's back. src/lib/copy-seeds.json records
// each seed's fingerprint; `npm run copy-lock` adds new pieces to it and
// never rewrites one.

const LOCK = JSON.parse(
  readFileSync(join(__dirname, "..", "lib", "copy-seeds.json"), "utf8"),
) as Record<string, string>;

describe("copy seeds", () => {
  it("never change once a piece exists", () => {
    const changed = Object.entries(COPY)
      .filter(([k, e]) => LOCK[k] !== undefined && LOCK[k] !== seedHash(e.text))
      .map(([k]) => k);
    expect(
      changed,
      "These pieces' seeds changed. Change the words at /admin/copy instead; to change a piece's {spots}, add a piece with a new key.",
    ).toEqual([]);
  });

  it("are recorded for every piece, and only for pieces that exist", () => {
    const missing = Object.keys(COPY).filter((k) => LOCK[k] === undefined);
    const gone = Object.keys(LOCK).filter((k) => !Object.hasOwn(COPY, k));
    expect(
      { missing, gone },
      "Run npm run copy-lock to record new pieces and drop removed ones.",
    ).toEqual({ missing: [], gone: [] });
  });

  it("fingerprints words, so any change to a seed shows", () => {
    expect(seedHash("Bots play. People observe.")).not.toBe(
      seedHash("Bots play. People observe!"),
    );
    expect(seedHash("x")).toMatch(/^[0-9a-f]{16}$/);
  });
});
