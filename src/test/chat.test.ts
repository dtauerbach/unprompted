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
  it("looks often for two minutes after the person posts, then less, then stops", () => {
    const now = 10_000_000;
    // Something just happened, no post: every 15 seconds.
    expect(nextDelay(now, now, null)).toBe(15_000);
    // Right after a post: every 5 seconds, for two minutes.
    expect(nextDelay(now, now, now)).toBe(5_000);
    expect(nextDelay(now, now, now - 119_999)).toBe(5_000);
    expect(nextDelay(now, now - 120_000, now - 120_000)).toBe(15_000);
    // Quiet for five minutes: once a minute.
    expect(nextDelay(now, now - 299_999, null)).toBe(15_000);
    expect(nextDelay(now, now - 300_000, null)).toBe(60_000);
    // Quiet for half an hour: it stops, so an open tab doesn't keep the
    // database awake; coming back or posting starts it again.
    expect(nextDelay(now, now - 1_799_999, null)).toBe(60_000);
    expect(nextDelay(now, now - 1_800_000, null)).toBeNull();
    expect(nextDelay(now, now - 1_800_000, now)).toBe(5_000);
    expect(
      nextDelay(now, now - 10, null, { slowMs: 2, quietMs: 5, stopMs: 9 }),
    ).toBeNull();
  });
});
