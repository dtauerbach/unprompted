import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { RETIRED_TOOLS } from "@/lib/mcp";
import { freshIp, register, resetDb } from "./helpers";

// Tools the connector no longer has answer with what to call instead, so an
// app that remembers an old name isn't left with a bare "not found". They
// stay out of the tool list, and a name that never was a tool is answered
// as before.

vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  connection: async () => {},
}));

beforeEach(resetDb);

let rpcId = 0;
// biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary JSON
async function rpc(key: string, method: string, params: unknown): Promise<any> {
  rpcId += 1;
  const req = new Request("http://unprompted.test/v1/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-real-ip": freshIp(),
      host: "unprompted.test",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params }),
  });
  const res = await mcpRoute(req, undefined as never);
  return res.json();
}

const callTool = (key: string, name: string, args: unknown = {}) =>
  rpc(key, "tools/call", { name, arguments: args });

describe("retired tools", () => {
  it("are the two the connector dropped, each naming what to call instead", () => {
    expect(Object.keys(RETIRED_TOOLS).sort()).toEqual([
      "read_messages",
      "send_message",
    ]);
    expect(RETIRED_TOOLS.send_message).toMatch(/call post with to/);
    expect(RETIRED_TOOLS.read_messages).toMatch(/Call read_channel instead/);
  });

  for (const [name, replacement] of [
    ["send_message", /post with to/],
    ["read_messages", /read_channel/],
  ] as const)
    it(`answers ${name} with its replacement, as a tool error`, async () => {
      const a = await register("alice");
      const out = await callTool(a.key, name, { to: "bob", body: "hi" });
      expect(out.error).toBeUndefined();
      expect(out.result.isError).toBe(true);
      const body = JSON.parse(out.result.content[0].text);
      expect(body).toEqual({
        error: { code: "tool_removed", message: RETIRED_TOOLS[name] },
      });
      expect(body.error.message).toMatch(replacement);
    });

  it("answers a name that never was a tool as before", async () => {
    const a = await register("alice");
    for (const name of ["no_such_tool", "send_messages", "readMessages"]) {
      const out = await callTool(a.key, name);
      expect(out.result.isError, name).toBe(true);
      expect(out.result.content[0].text, name).toBe(
        `MCP error -32602: Tool ${name} not found`,
      );
    }
  });

  it("never take a name off an object's prototype for a retired tool", async () => {
    const a = await register("alice");
    // The SDK has its own answer for these; the hint isn't it.
    for (const name of ["constructor", "toString", "__proto__"]) {
      const out = await callTool(a.key, name);
      expect(out.result.content[0].text, name).not.toContain("tool_removed");
    }
  });

  it("leaves every other tool alone", async () => {
    const a = await register("alice");
    const out = await callTool(a.key, "whoami");
    expect(out.result.isError).toBeFalsy();
    expect(JSON.parse(out.result.content[0].text).bot.handle).toBe("alice");
  });

  it("stay out of the tool list, beside the tools that replace them", async () => {
    const a = await register("alice");
    const out = await rpc(a.key, "tools/list", {});
    const names: string[] = out.result.tools.map(
      (t: { name: string }) => t.name,
    );
    for (const gone of Object.keys(RETIRED_TOOLS))
      expect(names).not.toContain(gone);
    expect(names).toEqual(expect.arrayContaining(["post", "read_channel"]));
  });
});
