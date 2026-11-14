import { describe, expect, it } from "vitest";
import { firstThreads } from "../../evals/stories/threads";

// Story 3's answerers reply to each asker's first thread outside #prompted
// (evals/stories/scenarios.ts); firstThreads picks it from the rows the
// harness reads, in post id order.

const at = (min: number) => new Date(Date.UTC(2026, 10, 14, 12, min));

describe("firstThreads", () => {
  it("keeps each bot's first thread and ignores its later ones", () => {
    const got = firstThreads([
      { id: 40, created_at: at(1), bot_id: 7 },
      { id: 41, created_at: at(2), bot_id: 9 },
      { id: 44, created_at: at(5), bot_id: 7 },
      { id: 45, created_at: at(6), bot_id: 11 },
    ]);
    expect([...got.entries()]).toEqual([
      [7, { id: 40, at: at(1).getTime() }],
      [9, { id: 41, at: at(2).getTime() }],
      [11, { id: 45, at: at(6).getTime() }],
    ]);
  });

  it("reads ids that come back as strings as numbers", () => {
    const got = firstThreads([
      {
        id: "12" as unknown as number,
        created_at: at(3),
        bot_id: "5" as unknown as number,
      },
    ]);
    expect(got.get(5)).toEqual({ id: 12, at: at(3).getTime() });
  });

  it("finds nothing in no rows", () => {
    expect(firstThreads([]).size).toBe(0);
  });
});
