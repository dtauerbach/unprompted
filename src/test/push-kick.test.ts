import { beforeEach, describe, expect, it, vi } from "vitest";

// Pushes go out after a write's answer, from the request itself: kickPushes
// hands one round to next/server's after(), runs at most one round at a
// time per server, and asks a running round to go once more.

const scheduled: (() => Promise<void>)[] = [];
vi.mock("next/server", () => ({
  after: (fn: () => Promise<void>) => {
    scheduled.push(fn);
  },
}));
const drain = vi.fn(async (_deliver?: unknown, _forMs?: number) => {});
vi.mock("@/lib/push", () => ({
  drainForAWhile: (deliver?: unknown, forMs?: number) => drain(deliver, forMs),
}));

beforeEach(() => {
  scheduled.length = 0;
  drain.mockClear();
  delete process.env.UNPROMPTED_READ_ONLY;
});

describe("kickPushes", () => {
  it("schedules one round after the answer, and none while one is waiting", async () => {
    const { kickPushes } = await import("@/lib/push-kick");
    kickPushes();
    kickPushes();
    expect(scheduled).toHaveLength(1);
    // Kicks before it starts are covered by the round itself.
    await scheduled[0]?.();
    expect(drain).toHaveBeenCalledTimes(1);
    // Kicks while a round runs ask for one more round, and no more.
    drain.mockImplementationOnce(async () => {
      kickPushes();
      kickPushes();
    });
    kickPushes();
    await scheduled[1]?.();
    expect(drain).toHaveBeenCalledTimes(3);
    expect(scheduled).toHaveLength(2);
    // Done: the next write schedules again.
    kickPushes();
    expect(scheduled).toHaveLength(3);
    await scheduled[2]?.();
    expect(drain).toHaveBeenCalledTimes(4);
  });

  it("lets a failed round go, and starts again on the next write", async () => {
    const { kickPushes } = await import("@/lib/push-kick");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    drain.mockRejectedValueOnce(new Error("database away"));
    kickPushes();
    await scheduled[0]?.();
    expect(spy).toHaveBeenCalled();
    kickPushes();
    expect(scheduled).toHaveLength(2);
    await scheduled[1]?.();
    spy.mockRestore();
  });

  it("keeps both passes of a round under one deadline, inside the stale window", async () => {
    const { kickPushes, KICK_ROUND_MS, KICK_STALE_MS } = await import(
      "@/lib/push-kick"
    );
    // The last push a round starts can run up to its timeout past the
    // deadline, and the round must still end inside the window.
    const { PUSH_TIMEOUT_MS } =
      await vi.importActual<typeof import("@/lib/push")>("@/lib/push");
    expect(KICK_ROUND_MS + PUSH_TIMEOUT_MS).toBeLessThan(KICK_STALE_MS);
    vi.useFakeTimers();
    try {
      drain.mockImplementationOnce(async () => {
        kickPushes();
        vi.advanceTimersByTime(20_000);
      });
      kickPushes();
      await scheduled[0]?.();
      expect(drain).toHaveBeenCalledTimes(2);
      const first = drain.mock.calls[0]?.[1] ?? 0;
      const second = drain.mock.calls[1]?.[1] ?? 0;
      expect(first).toBe(KICK_ROUND_MS);
      expect(second).toBe(KICK_ROUND_MS - 20_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does nothing under the kill switch", async () => {
    const { kickPushes } = await import("@/lib/push-kick");
    process.env.UNPROMPTED_READ_ONLY = "1";
    kickPushes();
    expect(scheduled).toHaveLength(0);
    delete process.env.UNPROMPTED_READ_ONLY;
  });

  it("takes a round the platform cut off as gone, after a while", async () => {
    const { kickPushes, KICK_STALE_MS } = await import("@/lib/push-kick");
    const t = 1_000_000_000_000;
    // A round is scheduled but never runs, as when after() is cut off.
    kickPushes(t);
    expect(scheduled).toHaveLength(1);
    kickPushes(t + 1000);
    expect(scheduled).toHaveLength(1);
    kickPushes(t + KICK_STALE_MS + 1);
    expect(scheduled).toHaveLength(2);
    // The stale round finishing late doesn't free the new one.
    await scheduled[0]?.();
    kickPushes(t + KICK_STALE_MS + 2);
    expect(scheduled).toHaveLength(2);
    await scheduled[1]?.();
    kickPushes(t + KICK_STALE_MS + 3);
    expect(scheduled).toHaveLength(3);
    await scheduled[2]?.();
  });
});
