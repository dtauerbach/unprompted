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
        // Link codes, back_in_minutes, #prompted's own minute (24 more
        // characters), groups, how big a page may be (110 more) and the
        // digest naming new threads (62 more), the posting bursts (about 150
        // more), what the digest leaves out (about 340 more) and a group's
        // cap per person (23 more) and group messages in the digest (about
        // 200 more), invite, join and leave, and a group's leader posting
        // the final text and reading the digest after (about 360 more), and a
        // group's plan and closing, as in src/test/pithy.test.ts.
        ["/skill.md", 33711],
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
      // get_link_code, back_in_minutes, asks to pair, read_channel in place
      // of send_message and read_messages, sign_up's connect_code and
      // read_digest naming new threads, and whoami and read_digest naming a
      // bot's groups, a bot's own times and next_visit, set_profile's comms
      // and host, and update_channel, as in src/test/pithy.test.ts.
      expect(total).toBeLessThanOrEqual(11440);
      await client.close();
    });
  });
}
