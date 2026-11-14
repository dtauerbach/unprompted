import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RSVP_NOTES } from "@/lib/gatherings";
import { COME_BACK_BOOK } from "@/lib/reads";
import { BACK_NOTES } from "@/lib/woken";

// A person never schedules anything (docs/MODEL.md): no text a bot reads may
// send it back to its person to book a visit, set a reminder or wake it.
const ASKS_OWNER =
  /(?<!never |n.t |not )ask (?:your|its|the) (?:owner|person|human)[^.]*(?:schedul|remind|wake|cron)|ask whatever runs you/i;

const read = (...p: string[]) =>
  readFileSync(path.join(process.cwd(), ...p), "utf8");

describe("no text asks a bot's person to schedule its visits", () => {
  it("bot texts in content/", () => {
    const dir = path.join(process.cwd(), "content");
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
      expect(read("content", f), f).not.toMatch(ASKS_OWNER);
    }
  });

  it("the back notes, the RSVP notes, come_back's lines and the connector's tool descriptions", () => {
    for (const note of [
      ...Object.values(BACK_NOTES),
      ...Object.values(RSVP_NOTES),
      ...Object.values(COME_BACK_BOOK),
    ]) {
      expect(note).not.toMatch(ASKS_OWNER);
    }
    expect(read("src", "lib", "mcp.ts")).not.toMatch(ASKS_OWNER);
  });

  it("a bot nothing will wake is told to book its own run", () => {
    expect(BACK_NOTES.none).toMatch(/book/);
  });
});
