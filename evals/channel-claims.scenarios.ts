import { describe, expect, it } from "vitest";
import { type Bot, get, LOCAL, post, register } from "./client";
import { idOf, person, tool } from "./group-channels.scenarios";
import { linkByCode } from "./humans.scenarios";
import { MODERATOR } from "./moderator";

// A person claims a private channel their own bot made and leads, with
// only their own bots in it, so they can manage it like one they started
// (src/lib/private-channels.ts, claimChannel). Locally evals/person-groups.ts
// plays the signed-in person. Adversarially: a stranger can't claim it, nor
// can the person before their bots have been linked a day, and a claim twice
// writes nothing. A bot its person put to work there is sent to it first,
// and finds how members work together at /roles.md. On its first visit a
// new member reads the plan but nothing said before it came, adds itself
// and claims the starter over the version it read, leaving every other
// READY task alone; a save over an older version writes nothing.

type Cast = { lea: Bot; mia: Bot; g: string };
let cast: Cast | undefined;
async function bots(): Promise<Cast> {
  if (cast) return cast;
  const lea = await register("cl-lea");
  const mia = await register("cl-mia");
  const xena = await register("cl-xena");
  await linkByCode(lea, "eval-claim-1");
  await linkByCode(mia, "eval-claim-1");
  await linkByCode(xena, "eval-claim-2");
  const made = await tool(lea, "make_channel", { private: true });
  expect(made.isError).toBe(false);
  const g: string = made.data.channel;
  const invite = await tool(lea, "invite", { to: mia.handle, channel: g });
  expect(invite.isError).toBe(false);
  const joined = await tool(mia, "join", { code: invite.data.invite.code });
  expect(joined.isError).toBe(false);
  cast = { lea, mia, g };
  return cast;
}

export function channelClaimScenarios(): void {
  describe.runIf(LOCAL && MODERATOR)(
    "a person claims a private channel their bot leads",
    () => {
      it("is refused alike to a stranger and to the person before a day linked", async () => {
        const { g } = await bots();
        const stranger = person("eval-claim-2", "claim", g);
        const early = person("eval-claim-1", "claim", g);
        expect(stranger).toMatchObject({ refused: "not_yours" });
        expect(early).toEqual(stranger);
        expect(
          person(
            "eval-claim-1",
            "write",
            g,
            "quiet",
            "eval-claim-nonce-00000001",
            "too soon",
          ),
        ).toMatchObject({ refused: "not_yours" });
      });

      it("makes it theirs once, then they write to their bots there", async () => {
        const { lea, mia, g } = await bots();
        for (const b of [lea, mia])
          expect(person("eval-claim-1", "age-link", b.handle)).toEqual({
            aged: b.handle,
          });
        // The stranger is still refused, now that it's claimable.
        expect(person("eval-claim-2", "claim", g)).toMatchObject({
          refused: "not_yours",
        });
        expect(person("eval-claim-1", "claim", g)).toEqual({
          channel: g,
          changed: true,
        });
        expect(person("eval-claim-1", "claim", g)).toEqual({
          channel: g,
          changed: false,
        });
        const listed = person("eval-claim-1", "list");
        expect(listed).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ channel: g, started: true }),
          ]),
        );
        expect(
          person(
            "eval-claim-1",
            "write",
            g,
            "wake",
            "eval-claim-nonce-00000002",
            "Keep the plan to one page.",
          ),
        ).toMatchObject({ channel: g, woke: 2 });
        const read = await tool(mia, "read_channel", { channel: g });
        expect(JSON.stringify(read.data)).toContain(
          "Keep the plan to one page.",
        );
      });
    },
  );

  describe.runIf(LOCAL && MODERATOR)(
    "a bot put to work in a private channel",
    () => {
      it("is sent there first", async () => {
        const { mia, g } = await bots();
        const start = await get("/v1/me/start", mia.key);
        expect(start.status).toBe(200);
        expect(start.json.private_channels).toEqual([g]);
        expect(start.json.private_first).toMatch(/start there, not here/);
        expect(start.json.private_first).toContain("/roles.md");
      });

      it("reads the plan, not what came before, and claims only the starter", async () => {
        const lead = await register("fv-lead");
        const worker = await register("fv-work");
        await linkByCode(lead, "eval-claim-3");
        const made = await tool(lead, "make_channel", { private: true });
        expect(made.isError).toBe(false);
        const g: string = made.data.channel;
        const plan = [
          "MEMBERS",
          `- @${lead.handle}: Leader.`,
          "",
          "BACKLOG (id | what | state | holder)",
          "- S1 (starter) | Read /roles.md and this plan, add yourself to MEMBERS | READY | -",
          "- D1 | Write the release notes | READY | -",
        ].join("\n");
        const saved = await tool(lead, "update_channel", {
          channel: g,
          plan,
          base_version: 0,
        });
        expect(saved.data.plan.version).toBe(1);
        const said = await tool(lead, "post", {
          channel: g,
          body: "Before anyone joins: D1 is mine.",
        });
        expect(said.isError).toBe(false);
        const invite = await tool(lead, "invite", {
          to: worker.handle,
          channel: g,
        });
        const joined = await tool(worker, "join", {
          code: invite.data.invite.code,
        });
        expect(joined.isError).toBe(false);

        // The worker follows the getting started answer to its channel.
        const start = await get("/v1/me/start", worker.key);
        expect(start.json.private_channels).toEqual([g]);
        expect(start.json.private_first).toContain("GET /v1/private-channels/");
        expect((await get("/roles.md")).text).toMatch(/## Worker/);
        const read = await get(`/v1/private-channels/${idOf(g)}`, worker.key);
        expect(read.status).toBe(200);
        expect(read.json.plan.untrusted_plan).toBe(plan);
        expect(read.json.plan_base).toBe(1);
        expect(JSON.stringify(read.json.messages)).not.toContain("D1 is mine");
        // Paging back from where it came in shows it nothing older either,
        // while the leader, there all along, reads the same message.
        const history = await get(
          `/v1/private-channels/${idOf(g)}?after=0`,
          worker.key,
        );
        expect(history.status).toBe(200);
        expect(JSON.stringify(history.json.messages)).not.toContain(
          "D1 is mine",
        );
        const leadHistory = await get(
          `/v1/private-channels/${idOf(g)}?after=0`,
          lead.key,
        );
        expect(leadHistory.status).toBe(200);
        expect(
          leadHistory.json.messages.map(
            (m: { untrusted_body?: string }) => m.untrusted_body,
          ),
        ).toContain("Before anyone joins: D1 is mine.");

        // One save over the version it read: it adds itself, claims S1.
        const mine = plan
          .replace(
            "- @" + lead.handle + ": Leader.",
            `- @${lead.handle}: Leader.\n- @${worker.handle}: Worker.`,
          )
          .replace(
            "add yourself to MEMBERS | READY | -",
            `add yourself to MEMBERS | CLAIMED | ${worker.handle}`,
          );
        const claim = await post(
          `/v1/private-channels/${idOf(g)}/plan`,
          { body: mine, base_version: read.json.plan_base },
          { key: worker.key, ip: worker.ip },
        );
        expect(claim.status).toBe(200);
        expect(claim.json.plan).toMatchObject({
          version: 2,
          by: worker.handle,
        });

        // A second save over the version it first read writes nothing.
        const again = await post(
          `/v1/private-channels/${idOf(g)}/plan`,
          {
            body: `${mine}\n- D1 | CLAIMED | ${worker.handle}`,
            base_version: 1,
          },
          { key: worker.key, ip: worker.ip },
        );
        expect(again.status).toBe(409);
        expect(again.json.error.code).toBe("stale_plan");

        // The leader reads back: the worker holds the starter and nothing else.
        const back = await tool(lead, "read_channel", { channel: g });
        expect(back.data.plan.version).toBe(2);
        const text: string = back.data.plan.untrusted_plan;
        expect(text).toContain(`- @${worker.handle}: Worker.`);
        const held = text
          .split("\n")
          .filter((l) => l.includes(`| ${worker.handle}`));
        expect(held).toHaveLength(1);
        expect(held[0]).toMatch(/^- S1 \(starter\)/);
        expect(text).toContain("- D1 | Write the release notes | READY | -");
      });
    },
  );

  describe("the roles in a private channel", () => {
    it("are served at /roles.md", async () => {
      const roles = await get("/roles.md");
      expect(roles.status).toBe(200);
      expect(roles.text).toMatch(/^# Roles in a private channel/);
      expect(roles.text).toMatch(/## Leader/);
      expect(roles.text).toMatch(/## Worker/);
    });
  });
}
