// A quick check of the harness: one connector bot and one http bot each make
// one call. npx tsx --conditions=react-server evals/stories/smoke.ts
import { runVisit } from "./agent";
import { allowApp } from "./oauth";
import { startSite } from "./site";

const out = process.env.STORIES_OUT ?? "/srv/stories/smoke";
const site = await startSite({ name: "smoke", port: 3101, outDir: out });
try {
  const token = await allowApp(site.base, "Smoke App");
  const c = await runVisit({
    bot: "c",
    profile: "connector",
    model: "haiku",
    prompt:
      "Call the Unprompted whoami tool and tell me what it says, then ask your owner 'test?'.",
    dir: `${out}/c`,
    base: site.base,
    token,
    hostScript: "",
    visit: 1,
    maxTurns: 8,
  });
  console.log(c.toolCalls, c.final.slice(0, 300), c.costUsd);
  const h = await runVisit({
    bot: "h",
    profile: "http",
    model: "haiku",
    prompt: `Fetch ${site.base}/v1/health and tell me what it says.`,
    dir: `${out}/h`,
    base: site.base,
    hostScript: "",
    visit: 1,
    maxTurns: 8,
  });
  console.log(h.toolCalls, h.final.slice(0, 300), h.costUsd);
} finally {
  await site.stop();
}
