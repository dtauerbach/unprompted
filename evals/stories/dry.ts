// A dry run of a story's setup: a fresh local site and the story's cast and
// setup, with no bot started and no model called, so it costs nothing. It
// prints what the bots would get (keys left out) and, for s5's leader arms,
// checks the group the person started and where each follower's wake
// listener would start from.
//   npx tsx --conditions=react-server evals/stories/dry.ts <story> <arm> [port]
import { mkdirSync } from "node:fs";
import path from "node:path";
import { api } from "./actors";
import { redact } from "./redact";
import type { Ctx } from "./run";
import { SCENARIOS } from "./scenarios";
import { startSite } from "./site";

const [id, arm = "a", portArg] = process.argv.slice(2);
const sc = SCENARIOS.find((s) => s.id === id);
if (!sc || !sc.arms.includes(arm)) {
  console.error(
    `usage: dry.ts <${SCENARIOS.map((s) => s.id).join("|")}> <arm> [port]`,
  );
  process.exit(1);
}
const dir = path.join(
  process.env.STORIES_OUT ?? "/srv/stories/runs",
  `dry-${id}-${arm}-${Date.now()}`,
);
mkdirSync(dir, { recursive: true });
const port = Number(portArg ?? 3100 + Math.floor(Math.random() * 800));
const site = await startSite({
  name: `dry_${id}_${arm}_${port}`,
  port,
  outDir: dir,
});
let failed = false;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed = true;
};
try {
  const ctx: Ctx = { site, dir, t0: Date.now(), arm };
  const setup = await sc.setup(ctx);
  console.log(
    redact(
      JSON.stringify(
        {
          setup_touches: setup.setupTouches ?? [],
          bots: setup.bots.map(({ token: _t, wake, ...b }) => ({
            ...b,
            wake: wake ? { prompt: wake.prompt, from: wake.from } : undefined,
          })),
        },
        null,
        1,
      ),
    ),
  );
  if (id === "s5" && arm.startsWith("leader")) {
    const c = (await setup.collect?.()) as {
      group?: { channel: string; leader: string; members: string[] };
    };
    check(c.group?.leader === "duet", "the group's leader is duet");
    check(
      JSON.stringify(c.group?.members) ===
        JSON.stringify(["duet", "quill", "scout"]),
      "the group holds duet, quill and scout",
    );
    for (const b of setup.bots) {
      const lines = b.line.toLowerCase();
      if (b.name === "duet")
        check(
          lines.includes("you lead") && !lines.includes("group"),
          "the owner's line says you lead and doesn't name the group",
        );
      if (!b.wake) continue;
      const now = Number(
        (await api(site.base, "GET", "/v1/me/wake", b.wake.key)).json?.wake,
      );
      check(b.line === "", `${b.name} hears nothing from the owner`);
      if (arm === "leader-cold")
        check(
          b.wake.from !== undefined && now > b.wake.from,
          `${b.name}'s listener starts below its wake number, so being put in wakes it`,
        );
      else
        check(
          b.wake.from === undefined,
          `${b.name}'s listener reads its number at the start, so being put in doesn't wake it`,
        );
      const listed = await api(site.base, "GET", "/v1/channels", b.wake.key);
      check(
        (listed.json?.private ?? []).some(
          (p: { leader?: string }) => p.leader === "duet",
        ),
        `${b.name} finds the group, led by duet, in its channel list`,
      );
    }
  }
} finally {
  await site.stop();
}
console.log(failed ? "dry run FAILED" : "dry run ok");
// The story's background (its minute-50 news) is left waiting: nothing ran.
process.exit(failed ? 1 : 0);
