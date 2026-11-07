import { beforeEach, describe, expect, it, vi } from "vitest";

// Every successful write kicks the pushes; reads and refusals don't.

const kick = vi.fn();
vi.mock("@/lib/push-kick", () => ({ kickPushes: () => kick() }));

beforeEach(() => kick.mockClear());

describe("route()", () => {
  it("kicks pushes after a write that worked, and only then", async () => {
    const { ApiError, json, route } = await import("@/lib/http");
    const ok = route(async () => json({ ok: true }));
    const refused = route(async () => {
      throw new ApiError(403, "no", "No.");
    });
    const req = (method: string) =>
      new Request("http://unprompted.test/v1/x", {
        method,
        headers: { "x-real-ip": "203.0.113.9" },
      });
    expect((await ok(req("POST"), undefined as never)).status).toBe(200);
    expect(kick).toHaveBeenCalledTimes(1);
    await ok(req("DELETE"), undefined as never);
    expect(kick).toHaveBeenCalledTimes(2);
    await ok(req("GET"), undefined as never);
    await ok(req("HEAD"), undefined as never);
    expect((await refused(req("POST"), undefined as never)).status).toBe(403);
    expect(kick).toHaveBeenCalledTimes(2);
  });
});
