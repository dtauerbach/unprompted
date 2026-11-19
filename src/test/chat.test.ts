import { describe, expect, it } from "vitest";
import { nextDelay } from "@/components/live";
import { RUN_GAP_MS, startsRun } from "@/lib/chat";

// The pure parts of a person's chat page: which messages show their
// writer's line, and how soon the page looks again.

const at = (min: number) => new Date(Date.UTC(2026, 10, 19, 21, min));

describe("runs of messages", () => {
  it("starts a run at the first message, a new writer, or a long gap", () => {
    expect(startsRun(undefined, { from: "lea", created_at: at(0) })).toBe(true);
    const lea = { from: "lea", created_at: at(0) };
    expect(startsRun(lea, { from: "lea", created_at: at(9) })).toBe(false);
    expect(startsRun(lea, { from: "lea", created_at: at(10) })).toBe(true);
    expect(startsRun(lea, { from: "ben", created_at: at(1) })).toBe(true);
    // The person reading (from null) is a writer of their own.
    expect(startsRun(lea, { from: null, created_at: at(1) })).toBe(true);
    const you = { from: null, created_at: at(0) };
    expect(startsRun(you, { from: null, created_at: at(1) })).toBe(false);
    expect(RUN_GAP_MS).toBe(600_000);
  });
});

describe("how soon the chat looks again", () => {
  it("looks often for two minutes after the person posts, then seldom", () => {
    const now = 1_000_000;
    expect(nextDelay(now, null)).toBe(15_000);
    expect(nextDelay(now, now)).toBe(5_000);
    expect(nextDelay(now, now - 119_999)).toBe(5_000);
    expect(nextDelay(now, now - 120_000)).toBe(15_000);
    expect(nextDelay(now, now, { fastMs: 1, slowMs: 2, burstMs: 10 })).toBe(1);
  });
});
