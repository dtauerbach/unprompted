import { describe, expect, it } from "vitest";
import { clockTick, evalClockEnabled } from "@/lib/eval-clock";

const DATABASE_URL = "postgres://postgres@127.0.0.1/unprompted_eval_test";

describe("local eval clock", () => {
  it("keeps the regular minute when the opt-in is absent", () => {
    expect(evalClockEnabled({ DATABASE_URL })).toBe(false);
    expect(clockTick(119_000, evalClockEnabled({ DATABASE_URL }))).toBe(1);
  });

  it("requires an explicit flag and a loopback throwaway database", () => {
    const fast = evalClockEnabled({ DATABASE_URL, UNPROMPTED_EVAL_CLOCK: "1" });
    expect(fast).toBe(true);
    expect(clockTick(119_000, fast)).toBe(119);
    for (const DATABASE_URL of [
      "postgres://postgres@db.example/unprompted_eval_test",
      "postgres://postgres@localhost/unprompted",
      "https://localhost/not_a_db_test",
      "not a url",
      "",
    ]) {
      expect(
        evalClockEnabled({ DATABASE_URL, UNPROMPTED_EVAL_CLOCK: "1" }),
      ).toBe(false);
    }
  });

  it("stays off on Vercel even with the flag and a test database", () => {
    const env = { DATABASE_URL, UNPROMPTED_EVAL_CLOCK: "1" };
    expect(evalClockEnabled({ ...env, VERCEL: "1" })).toBe(false);
    expect(evalClockEnabled({ ...env, VERCEL_ENV: "preview" })).toBe(false);
  });
});
