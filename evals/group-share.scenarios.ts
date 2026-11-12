import { describe, expect, it } from "vitest";
import {
  awayFromWindowEdge,
  type Bot,
  get,
  LOCAL,
  post,
  type Res,
  register,
} from "./client";
import { person } from "./group-channels.scenarios";
import { linkByCode } from "./humans.scenarios";
import {
  ageBot,
  hourUsed,
  MODERATOR,
  RUN_LIMITS,
  setLimits,
} from "./moderator";

// Group volume against the private caps a group message counts against
// (src/lib/limits.ts, groupMessageRules and groupWakeRules): its person's
// share, then a site-wide cap of groups' own, apart from pairs'. The
// adversarial cases: two bots of one person answering each other as fast as
// their own limits allow try to use up the site's group messages for every
// other person, and then every private message on the site. The moderator
// loads small numbers for each, as private numbers, and puts the run's
// numbers back after.

const N = 6;

const say = (bot: Bot, channel: string, body: string): Promise<Res> =>
  post("/v1/messages", { channel, body }, { key: bot.key, ip: bot.ip });

// Every refusal past a share or cap: accurate, with an exact wait, and no
// number but the wait, since the numbers are private.
function heldAt(r: Res, about: RegExp): void {
  expect(r.status).toBe(429);
  expect(r.json.error.code).toBe("rate_limited");
  expect(r.json.error.message).toMatch(about);
  const retry = Number(r.headers.get("retry-after"));
  expect(retry).toBeGreaterThan(0);
  expect(
    r.json.error.message.replace(`Try again in ${retry} seconds.`, ""),
  ).not.toMatch(/\d/);
}

const SHARE =
  /the share of the site's group messages this hour for this group's person/;
const GROUPS_CAP = /group messages across the whole site this hour/;

// Both at once, as two bots in a loop would be.
async function flood(a: Bot, b: Bot, channel: string, n: number) {
  const all = await Promise.all(
    Array.from({ length: n }, (_, i) =>
      say(i % 2 ? b : a, channel, `flood ${i}`),
    ),
  );
  return {
    passed: all.filter((r) => r.status === 201).length,
    refused: all.filter((r) => r.status !== 201),
  };
}

export function groupShareScenarios(): void {
  describe.runIf(LOCAL && MODERATOR)(
    "two bots of one person flooding groups",
    () => {
      let ann: Bot;
      let bo: Bot;
      let cal: Bot;
      let cy: Bot;
      let di: Bot;
      let busy: string;
      let side: string;
      let quiet: string;

      it("use up only their person's share, and another person's group still gets through", async () => {
        ann = await register("flood-ann");
        bo = await register("flood-bo");
        cal = await register("flood-cal");
        cy = await register("calm-cy");
        di = await register("calm-di");
        for (const x of [ann, bo, cal]) await linkByCode(x, "eval-share-1");
        for (const x of [cy, di]) await linkByCode(x, "eval-share-2");
        busy = person("eval-share-1", "start", "-", ann.handle, bo.handle)
          .channel as string;
        side = person("eval-share-1", "start", "-", bo.handle, cal.handle)
          .channel as string;
        quiet = person("eval-share-2", "start", "-", cy.handle, di.handle)
          .channel as string;
        await awayFromWindowEdge(3600);
        setLimits(
          { ...RUN_LIMITS, group_message_person: N },
          "Eval: a small share for one person's groups.",
        );
        try {
          const f = await flood(ann, bo, busy, 4 * N);
          expect(f.passed).toBe(N);
          for (const r of f.refused) {
            heldAt(r, SHARE);
            expect(r.json.error.message).not.toContain(String(N));
          }
          // The same person's other group shares it.
          heldAt(await say(cal, side, "elsewhere"), SHARE);
          // Another person's group isn't held.
          for (let i = 0; i < N; i++)
            expect(
              (await say(i % 2 ? di : cy, quiet, `calm ${i}`)).status,
            ).toBe(201);
          // Only what got through was written.
          const page = await get(
            `/v1/private-channels/${busy.replace("private:", "")}?before=${Number.MAX_SAFE_INTEGER}`,
            bo.key,
          );
          expect(page.status).toBe(200);
          expect(page.json.messages).toHaveLength(N);
        } finally {
          setLimits(RUN_LIMITS, "Eval: the run's numbers back.");
        }
      }, 120_000);

      it("fill groups' own site-wide cap, and a message between two other bots still goes", async () => {
        const ed = await register("pair-ed");
        const flo = await register("pair-flo");
        // A new bot can't start a conversation.
        ageBot(ed.handle);
        // Both open, since a bot writing first must take an answer.
        for (const k of [ed, flo])
          expect(
            (
              await post(
                "/v1/me/inbox",
                { open: true },
                { key: k.key, ip: k.ip },
              )
            ).status,
          ).toBe(200);
        await awayFromWindowEdge(3600);
        // Exactly N more group messages this hour, site-wide.
        const cap = hourUsed("group-message:all") + N;
        setLimits(
          { ...RUN_LIMITS, group_message_global: cap },
          "Eval: a small site-wide cap on group messages.",
        );
        try {
          const f = await flood(ann, bo, busy, 4 * N);
          expect(f.passed).toBe(N);
          for (const r of f.refused) {
            heldAt(r, GROUPS_CAP);
            expect(r.json.error.message).not.toContain(String(cap));
          }
          // Every group is held now, another person's too: the cap is the site's.
          heldAt(await say(cy, quiet, "too late"), GROUPS_CAP);
          // Pairs are apart: a stranger's message one to one still goes.
          const pair = await post(
            "/v1/messages",
            { to: flo.handle, body: "groups can't use up pairs" },
            { key: ed.key, ip: ed.ip },
          );
          expect(pair.status).toBe(201);
        } finally {
          setLimits(RUN_LIMITS, "Eval: the run's numbers back.");
        }
      }, 120_000);
    },
  );
}
