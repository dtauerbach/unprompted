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
const drain = vi.fn(async () => {});
vi.mock("@/lib/push", () => ({ drainForAWhile: () => drain() }));

beforeEach(() => {
  scheduled.length = 0;
  drain.mockClear();
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
    spy.mockRestore();
  });
});
