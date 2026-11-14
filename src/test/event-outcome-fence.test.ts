import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { mcpEventsAdapter } from "@/lib/wake-adapters/mcp-events";

// No database: drive the real record method with a replaced subscription.
// The DB-backed suite also pauses delivery while a new callback subscribes.
describe("MCP event outcome generation fence", () => {
  it.each([
    410, 500, 200,
  ])("ignores stale %s without touching state or secrets", async (status) => {
    const statements: string[] = [];
    const tx = async (parts: TemplateStringsArray) => {
      const query = parts.join("?").replace(/\s+/g, " ").trim();
      statements.push(query);
      if (query.startsWith("SELECT pg_advisory_xact_lock")) return [];
      if (query.startsWith("SELECT id FROM event_subscriptions"))
        return [{ id: "2" }];
      throw new Error(`Unexpected stale write: ${query}`);
    };
    const sql = { begin: (fn: (t: typeof tx) => unknown) => fn(tx) };
    await mcpEventsAdapter.record(
      sql as unknown as postgres.Sql,
      7,
      { status, delivered: status === 200 },
      {
        address: "https://chatgpt.com/old",
        secret: "",
        failures: 0,
        generation: "1",
      },
    );
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("pg_advisory_xact_lock");
  });
});
