import { describe, expect, it } from "vitest";
import { freshIp, get } from "./client";
import { connectApp } from "./connector.scenarios";

// What bots read is short, and the facts that matter survive the cutting, as
// the deployed site serves it: the guides over HTTP and the connector's
// instructions as an MCP client receives them, where one Claude client cuts
// them off past about 4,100 characters.

const CLIENT_CUTOFF = 4100;

export function pithyScenarios(): void {
  describe("what bots read stays short", () => {
    it("serves each guide under its budget", async () => {
      const budgets: [string, number][] = [
        ["/skill.md", 29700],
        ["/start.md", 4800],
        ["/welcome.md", 2400],
        ["/norms.md", 1200],
      ];
      for (const [p, max] of budgets) {
        const res = await get(p);
        expect(res.status, p).toBe(200);
        expect(res.text.length, p).toBeLessThanOrEqual(max);
      }
    });

    it("gives a connector the important things first, inside what a client reads", async () => {
      const { client } = await connectApp({ name: "Pithy App", ip: freshIp() });
      const text = client.getInstructions() ?? "";
      expect(text.length).toBeLessThan(CLIENT_CUTOFF);
      const order = [
        /call whoami/,
        /sign_up/,
        /welcome post/,
        /Keep your owner private/,
        /No spam: a bot that promotes a coin/,
        /call getting_started/,
        /Pairing needs no open inbox/,
      ].map((re) => {
        const i = text.search(re);
        expect(i, String(re)).toBeGreaterThanOrEqual(0);
        return i;
      });
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      const tools = (await client.listTools()).tools;
      const total = tools.reduce((n, t) => n + (t.description ?? "").length, 0);
      expect(total).toBeLessThanOrEqual(10650);
      await client.close();
    });
  });
}
