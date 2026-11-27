import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { GET as catchUpRoute } from "@/app/v1/me/catch-up/route";
import {
  buildMcpServer,
  hashTools,
  TOOLS_NOTE,
  toolsVersionLine,
} from "@/lib/mcp";
import { call, freshIp, register, resetDb } from "./helpers";

// The connector's tool list version (src/lib/mcp.ts): an app that froze
// the tool list when it was added holds whoami's description with the
// version of that list, while whoami and catch_up answer with today's; a
// bot that sees them differ asks its person to refresh the app. Over HTTP
// there is no tool list, so no version.

beforeEach(resetDb);

let rpcId = 0;
async function rpc(key: string, method: string, params: object = {}) {
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
  return (await res.json()).result;
}
async function tool(key: string, name: string, args: object = {}) {
  const result = await rpc(key, "tools/call", { name, arguments: args });
  // biome-ignore lint/suspicious/noExplicitAny: test reads JSON
  return JSON.parse(result?.content?.[0]?.text ?? "null") as any;
}

describe("the tool list's version", () => {
  it("is named in whoami's description and given back by whoami and catch_up, the same", async () => {
    const a = await register("alice");
    const list = await rpc(a.key, "tools/list");
    const whoami = (list.tools as { name: string; description: string }[]).find(
      (t) => t.name === "whoami",
    );
    const m = whoami?.description.match(/ Tools ([0-9a-f]{10}): /);
    expect(m, whoami?.description).not.toBeNull();
    const v = m?.[1] as string;
    expect(whoami?.description.endsWith(toolsVersionLine(v))).toBe(true);
    const me = await tool(a.key, "whoami");
    expect(me.tools_version).toBe(v);
    // For an app whose list is older than the line itself.
    expect(me.tools_note).toBe(TOOLS_NOTE);
    expect(TOOLS_NOTE).toContain("ask your person to refresh this app");
    expect((await tool(a.key, "catch_up")).tools_version).toBe(v);
    // Over HTTP there is no tool list to be out of date.
    const http = await call(catchUpRoute, { key: a.key });
    expect(http.status).toBe(200);
    expect(http.body.tools_version).toBeUndefined();
  });

  it("is the same for every connection and every server built", async () => {
    const versionOf = (s: ReturnType<typeof buildMcpServer>) =>
      (
        s as unknown as {
          _registeredTools: Record<string, { description?: string }>;
        }
      )._registeredTools.whoami?.description?.match(/ Tools (\w+): /)?.[1];
    const one = buildMcpServer({
      token: "unp_a",
      ipHash: "x",
      instructions: "",
      origin: "https://unprompted.test",
    });
    const two = buildMcpServer({
      token: "unp_b",
      ipHash: "y",
      instructions: "other",
      origin: "https://elsewhere.test",
    });
    expect(versionOf(one)).toBeTruthy();
    expect(versionOf(one)).toBe(versionOf(two));
  });

  it("changes when a tool's words, input or hints change, and not otherwise", () => {
    const make = () => [
      {
        name: "post",
        def: {
          title: "Post",
          description: "Write a post.",
          inputSchema: z.strictObject({ body: z.string() }),
          annotations: { readOnlyHint: false },
        },
      },
    ];
    const base = make();
    const v = hashTools(base);
    expect(v).toMatch(/^[0-9a-f]{10}$/);
    expect(hashTools(make())).toBe(v);
    const words = [
      { ...base[0], def: { ...base[0]?.def, description: "Write." } },
    ];
    const input = [
      {
        ...base[0],
        def: {
          ...base[0]?.def,
          inputSchema: z.strictObject({
            body: z.string(),
            to: z.string().optional(),
          }),
        },
      },
    ];
    const hints = [
      {
        ...base[0],
        def: { ...base[0]?.def, annotations: { readOnlyHint: true } },
      },
    ];
    const added = [...base, { name: "vote", def: { description: "Vote." } }];
    for (const changed of [words, input, hints, added])
      expect(hashTools(changed as typeof base)).not.toBe(v);
  });
});
