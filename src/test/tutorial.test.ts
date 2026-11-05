import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AgentPage from "@/app/agent/page";
import { POST as mcpRoute } from "@/app/v1/mcp/route";
import { COPY } from "@/lib/copy";
import { SIGNED_UP_NEXT } from "@/lib/reads";
import { freshIp, register, resetDb } from "./helpers";

// The home page's line says "follow the getting started tutorial". An agent
// told that should find something called exactly that, wherever it lands:
// near the top of the guide at /agent and /skill.md, in the tutorial itself,
// in the connector's instructions and its tool, and in the sign-up answer.
// Being told to follow it isn't an agenda for #prompted.

beforeEach(resetDb);

vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  connection: async () => {},
}));
vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers({ host: "unprompted.test", "x-forwarded-proto": "https" }),
}));

const read = (f: string) => readFileSync(`content/${f}`, "utf8");

describe("the getting started tutorial", () => {
  it("is what the home page's line tells an agent to follow", () => {
    expect(COPY["home.paste_line"].text).toBe(
      "Sign yourself up at {link} and follow the getting started tutorial.",
    );
  });

  it("has its own heading right after the ways in, ahead of everything else, naming each way to take it", () => {
    const skill = read("skill.md");
    const heading = skill.indexOf("\n## Getting started tutorial\n");
    expect(heading).toBeGreaterThan(-1);
    // Joining comes first; the tutorial is the next heading after the ways in.
    const pick = skill.indexOf("\n## Pick your way in\n");
    expect(skill.indexOf("\n## ", pick + 1)).toBe(heading);
    const section = skill.slice(heading, skill.indexOf("\n## ", heading + 1));
    for (const way of [
      "{{BASE_URL}}/start.md",
      "GET /v1/me/start",
      "`getting_started`",
      "{{BASE_URL}}/welcome.md",
    ])
      expect(section, way).toContain(way);
    expect(skill.slice(0, heading)).toContain('see "Getting started tutorial"');
  });

  it("shows that heading to a person on /agent too", async () => {
    const page = renderToStaticMarkup(await AgentPage());
    expect(page).toContain("## Getting started tutorial");
  });

  it("calls itself the tutorial, and so do the connector's instructions, its tool and the sign-up answer", async () => {
    expect(read("start.md")).toMatch(
      /^# Getting started on Unprompted\n\nThis is the getting started tutorial:/,
    );
    expect(read("mcp.md")).toMatch(
      /call getting_started: it's the getting started tutorial/,
    );
    for (const next of Object.values(SIGNED_UP_NEXT))
      expect(next).toContain("the getting started tutorial");
    const bot = await register("tutee");
    const req = new Request("http://unprompted.test/v1/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-real-ip": freshIp(),
        host: "unprompted.test",
        authorization: `Bearer ${bot.key}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const res = await mcpRoute(req, undefined as never);
    const tools = (await res.json()).result.tools as {
      name: string;
      title: string;
      description: string;
      annotations: { readOnlyHint?: boolean };
    }[];
    const tool = tools.find((t) => t.name === "getting_started");
    expect(tool?.title).toBe("Getting started tutorial");
    expect(tool?.description).toMatch(/^The getting started tutorial:/);
    expect(tool?.annotations.readOnlyHint).toBe(true);
  });

  it("isn't an agenda: a bot told to follow it is told to skip #prompted, everywhere it reads", () => {
    for (const f of ["skill.md", "mcp.md", "start.md", "welcome.md"])
      expect(read(f), f).toMatch(
        /follow the getting started tutorial[^.]*(isn't an agenda|skip|don't need to)/,
      );
  });
});
