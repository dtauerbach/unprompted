import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Deliver } from "@/lib/push";
import { mcpEventsAdapter } from "@/lib/wake-adapters/mcp-events";

afterEach(() => vi.useRealTimers());

describe("MCP wake retry identity", () => {
  it("keeps the event identity after receipt followed by a lost response", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-13T18:00:00Z"));
    const registration = {
      address: "https://chatgpt.com/example-callback",
      secret: JSON.stringify({
        id: "sub_example",
        keys: [randomBytes(32).toString("base64")],
      }),
      failures: 0,
    };
    const received: { body: string; headers: Record<string, string> }[] = [];
    const deliver: Deliver = async (_url, body, headers) => {
      received.push({ body, headers }); // receiver accepted the message
      return received.length === 1
        ? { status: null, error: "timeout" }
        : { status: 200 };
    };
    const first = await mcpEventsAdapter.send(
      registration,
      {
        handle: "example",
        wake: 7,
        changedAt: new Date("2026-11-13T17:59:00Z"),
      },
      deliver,
    );
    expect(first.delivered).toBe(false);
    vi.setSystemTime(new Date("2026-11-13T18:02:00Z"));
    await mcpEventsAdapter.send(
      // Reconstructed after restart, with a rotated signing secret.
      {
        ...registration,
        secret: JSON.stringify({
          id: "sub_example",
          keys: [randomBytes(32).toString("base64")],
        }),
      },
      {
        handle: "example",
        wake: 7,
        changedAt: new Date("2026-11-13T17:59:00Z"),
      },
      deliver,
    );
    expect(received).toHaveLength(2);
    const [initial, retry] = received;
    if (!initial || !retry) throw new Error("missing captured attempt");
    const a = JSON.parse(initial.body);
    const b = JSON.parse(retry.body);
    expect.soft(b.eventId).toBe(a.eventId);
    expect.soft(b.timestamp).toBe(a.timestamp);
    expect(b.timestamp).toBe("2026-11-13T17:59:00.000Z");
    expect
      .soft(retry.headers["webhook-id"])
      .toBe(initial.headers["webhook-id"]);
    expect(retry.headers["webhook-timestamp"]).not.toBe(
      initial.headers["webhook-timestamp"],
    );
    await mcpEventsAdapter.send(
      registration,
      {
        handle: "example",
        wake: 8,
        changedAt: new Date("2026-11-13T18:01:00Z"),
      },
      deliver,
    );
    const newer = JSON.parse(received[2]?.body ?? "{}");
    expect(newer.eventId).not.toBe(a.eventId);
    expect(newer.timestamp).toBe("2026-11-13T18:01:00.000Z");
  });

  it.each([
    null,
    undefined,
    new Date("invalid"),
  ])("does not invent an occurrence time for %s", async (changedAt) => {
    const deliver = vi.fn();
    const result = await mcpEventsAdapter.send(
      {
        address: "https://chatgpt.com/example",
        secret: JSON.stringify({
          id: "sub_example",
          keys: [randomBytes(32).toString("base64")],
        }),
        failures: 0,
      },
      { handle: "example", wake: 1, changedAt },
      deliver,
    );
    expect(result).toMatchObject({ delivered: false, error: "event_time" });
    expect(deliver).not.toHaveBeenCalled();
  });
  it("does not emit a zero wake even if a timestamp is supplied", async () => {
    const deliver = vi.fn();
    const result = await mcpEventsAdapter.send(
      {
        address: "https://chatgpt.com/example",
        secret: JSON.stringify({
          id: "sub_example",
          keys: [randomBytes(32).toString("base64")],
        }),
        failures: 0,
      },
      { handle: "example", wake: 0, changedAt: new Date() },
      deliver,
    );
    expect(result).toMatchObject({ delivered: false, error: "event_time" });
    expect(deliver).not.toHaveBeenCalled();
  });
});
