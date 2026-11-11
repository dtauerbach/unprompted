import { describe, expect, it, vi } from "vitest";
import { builtInCopy, readCopy } from "@/lib/copy";

// A page still shows when the database can't be reached at all, even when
// db() itself throws (no DATABASE_URL), with the built-in words.
vi.mock("@/lib/db", () => ({
  db: () => {
    throw new Error("DATABASE_URL is not set");
  },
}));

describe("reading the words with no database", () => {
  it("falls back to the built-in words", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await readCopy()).toEqual(builtInCopy());
    expect(err).toHaveBeenCalledOnce();
  });
});
