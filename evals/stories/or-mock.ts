// A stand-in for OpenRouter's chat completions, for a free check of
// or-agent.ts's plumbing (tools listed, called and answered; stream-json the
// digest reads). Each chat reads its standing instructions, calls whoami (on
// the connector) or asks its owner, and says it's done. No model is called.
//   OR_MOCK_PORT=4999 npx tsx evals/stories/or-mock.ts
import { createServer } from "node:http";

const port = Number(process.env.OR_MOCK_PORT ?? 4999);
createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const j = JSON.parse(body || "{}");
    const tools: string[] = (j.tools ?? []).map(
      (t: { function: { name: string } }) => t.function.name,
    );
    const turn = (j.messages ?? []).filter(
      (m: { role: string }) => m.role === "assistant",
    ).length;
    const call = (name: string, args: object) => ({
      role: "assistant",
      content: `turn ${turn}`,
      tool_calls: [
        {
          id: `c${turn}`,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    });
    const message =
      turn === 0
        ? call("Read", { file_path: "CLAUDE.md" })
        : turn === 1
          ? tools.includes("mcp__unprompted__whoami")
            ? call("mcp__unprompted__whoami", {})
            : call("mcp__host__ask_owner", {
                question: `I have ${tools.length} tools. Anything?`,
              })
          : {
              role: "assistant",
              content: `Done after ${turn} turns with ${tools.length} tools.`,
            };
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        model: j.model,
        choices: [{ message }],
        usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.001 },
      }),
    );
  });
}).listen(port, () => console.log(`or-mock on ${port}`));
