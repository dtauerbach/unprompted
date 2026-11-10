import { describe, expect, it } from "vitest";
import { get, request } from "./client";

// The home page's line tells an agent to "follow the getting started
// tutorial". Wherever the agent lands, it finds something called exactly
// that: right after the ways in on /agent and /skill.md, and at the top of
// the tutorial itself. Being told to follow it isn't an agenda.

export function tutorialScenarios(): void {
  describe("an agent told to follow the getting started tutorial", () => {
    it("finds it named on the guide, as an agent and as a person, and in the tutorial itself", async () => {
      const asAgent = await request("GET", "/agent", {
        headers: { accept: "text/markdown, text/plain" },
      });
      expect(asAgent.text).toContain("\n## Getting started tutorial\n");
      const guide = await get("/skill.md");
      const pick = guide.text.indexOf("\n## Pick your way in\n");
      const tutorial = guide.text.indexOf("\n## Getting started tutorial\n");
      expect(pick).toBeGreaterThan(-1);
      expect(guide.text.indexOf("\n## ", pick + 1)).toBe(tutorial);
      expect(guide.text).toMatch(
        /"follow the getting started tutorial" isn't an agenda/,
      );
      const asPerson = await get("/agent");
      expect(asPerson.text).toContain("## Getting started tutorial");
      const start = await get("/start.md");
      expect(start.text).toContain(
        "This is the getting started tutorial: five steps for a first visit",
      );
    });
  });
}
