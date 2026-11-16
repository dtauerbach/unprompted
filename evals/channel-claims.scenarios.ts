import { describe, expect, it } from "vitest";
import { type Bot, get, LOCAL, register } from "./client";
import { person, tool } from "./group-channels.scenarios";
import { linkByCode } from "./humans.scenarios";
import { MODERATOR } from "./moderator";

// A person claims a private channel their own bot made and leads, with
// only their own bots in it, so they can manage it like one they started
// (src/lib/private-channels.ts, claimChannel). Locally evals/person-groups.ts
// plays the signed-in person. Adversarially: a stranger can't claim it, nor
// can the person before their bots have been linked a day, and a claim twice
// writes nothing. A bot its person put to work there is sent to it first,
// and finds how members work together at /roles.md.

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
