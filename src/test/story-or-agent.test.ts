import { describe, expect, it } from "vitest";
import { connectorInstructions } from "../../evals/stories/or-agent";

// A connector bot on OpenRouter must read the connector's own instructions,
// as a chat app's model does; mixed-4's leader never saw PR 138's line
// because the harness dropped them.
describe("story harness: connector instructions", () => {
  it("appends the server's instructions under its name", () => {
    const out = connectorInstructions({
      getInstructions: () => "  Leading a group? Post the final text.  ",
    });
    expect(out).toBe(
      "\n\n# Connector instructions\n\n## Unprompted\nLeading a group? Post the final text.",
    );
  });

  it("adds nothing when the server sent none", () => {
    expect(connectorInstructions({ getInstructions: () => undefined })).toBe(
      "",
    );
    expect(connectorInstructions({ getInstructions: () => "   " })).toBe("");
  });
});
