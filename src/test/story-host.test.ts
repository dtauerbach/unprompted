import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { newKey, newPairingCode } from "@/lib/keys";
import {
  type HostInbox,
  startHostInbox,
  tellRunner,
} from "../../evals/stories/inbox";

// A story bot's host tools (evals/stories/host-mcp.ts) log every call to
// host.jsonl, which people read, so the log is redacted; the runner gets
// each entry whole through its inbox (evals/stories/inbox.ts), since a
// message passed between owners can carry a code the other bot needs.

let inbox: HostInbox | undefined;
afterEach(async () => {
  await inbox?.close();
  inbox = undefined;
});

async function host(env: Record<string, string>) {
  const client = new Client({ name: "story-host-test", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: "npx",
      args: ["tsx", path.join(process.cwd(), "evals/stories/host-mcp.ts")],
      env: { PATH: process.env.PATH ?? "", ...env },
      stderr: "ignore",
    }),
  );
  return client;
}

describe("the host's log", () => {
  it("writes codes and keys cut, and hands the runner each entry whole", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "story-host-"));
    const log = path.join(dir, "host.jsonl");
    const script = path.join(dir, "owner.json");
    writeFileSync(script, JSON.stringify({ visits_allowed: 1 }));
    inbox = await startHostInbox();
    const pair = newPairingCode().code;
    const key = newKey().secret;
    const client = await host({
      HOST_LOG: log,
      HOST_SCRIPT: script,
      HOST_OTHERS: "Ana",
      HOST_INBOX: inbox.urlFor("duet"),
    });
    try {
      await client.callTool({
        name: "tell_owner",
        arguments: {
          message: `Please give Ana this code: ${pair}`,
          pass_to: "Ana",
        },
      });
      await client.callTool({
        name: "schedule_visit",
        arguments: { in_minutes: 10, note: `my key is ${key}` },
      });
      // The owner's allowance still counts from the redacted log.
      const second = await client.callTool({
        name: "schedule_visit",
        arguments: { in_minutes: 20, note: "again" },
      });
      expect(JSON.stringify(second.content)).toContain(
        "no more scheduled visits",
      );
    } finally {
      await client.close();
    }
    const written = readFileSync(log, "utf8");
    expect(written).toContain("pair_…");
    expect(written).toContain(`unp_…${key.slice(-4)}`);
    for (const secret of [pair, key])
      expect(written).not.toContain(secret.slice(-20, -4));
    expect(
      written
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l).kind),
    ).toEqual([
      "tell_owner",
      "schedule_visit_granted",
      "schedule_visit_refused",
    ]);
    const got = inbox.entries("duet");
    expect(got.map((e) => e.kind)).toEqual([
      "tell_owner",
      "schedule_visit_granted",
      "schedule_visit_refused",
    ]);
    expect(got[0]?.message).toBe(`Please give Ana this code: ${pair}`);
    expect(got[0]?.delivered).toBe(true);
    expect(got[1]?.note).toBe(`my key is ${key}`);
    expect(inbox.entries("scout")).toEqual([]);
  }, 60_000);

  it("keeps entries per bot, in order, and refuses what isn't an entry", async () => {
    inbox = await startHostInbox();
    expect(await tellRunner(inbox.urlFor("a b"), { kind: "x", at: "1" })).toBe(
      true,
    );
    expect(await tellRunner(inbox.urlFor("a b"), { kind: "y", at: "2" })).toBe(
      true,
    );
    const bad = await fetch(inbox.urlFor("a b"), {
      method: "POST",
      body: "{}",
    });
    expect(bad.status).toBe(400);
    expect(inbox.entries("a b").map((e) => e.kind)).toEqual(["x", "y"]);
    // No runner: the entry is only in the log.
    expect(await tellRunner(undefined, { kind: "x", at: "1" })).toBe(false);
    await inbox.close();
    expect(await tellRunner(inbox.urlFor("a b"), { kind: "z", at: "3" })).toBe(
      false,
    );
    inbox = undefined;
  });
});
