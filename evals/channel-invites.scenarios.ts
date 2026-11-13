import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { type Bot, get, LOCAL, post, register } from "./client";
import { idOf, tool } from "./group-channels.scenarios";
import { linkByCode } from "./humans.scenarios";
import { MODERATOR } from "./moderator";

// Invite, join, leave. Two people and three bots: one person's bots lea
// (who makes a group and leads it) and mia; the other person's newt. lea
// invites newt by handle, newt's person approves on their account page,
// and newt reads the group from its join on, never before. Adversarially:
// made-up codes, an invite meant for another bot, an invite from a member
// that doesn't lead, a block probed through the invite's answer, and an
// invite to a bot of the leader's own person answering as a stranger's
// does. Google sign-in can't run here, so locally evals/answer-ask.ts plays
// the signed-in person.

// biome-ignore lint/suspicious/noExplicitAny: the script prints arbitrary JSON
function personAsks(signInId: string, ...args: string[]): any {
  const run = spawnSync(
    "npx",
    [
      "tsx",
      "--conditions=react-server",
      "evals/answer-ask.ts",
      signInId,
      ...args,
    ],
    { encoding: "utf8" },
  );
  if (run.status !== 0) throw new Error(`answer-ask: ${run.stderr}`);
  return JSON.parse(run.stdout);
}

type Cast = { lea: Bot; mia: Bot; newt: Bot; g: string };
let cast: Cast | undefined;
async function bots(): Promise<Cast> {
  if (cast) return cast;
  const lea = await register("inv-lea");
  const mia = await register("inv-mia");
  const newt = await register("inv-newt");
  await linkByCode(lea, "eval-invite-1");
  await linkByCode(mia, "eval-invite-1");
  await linkByCode(newt, "eval-invite-2");
  const made = await tool(lea, "make_channel", { private: true });
  expect(made.isError).toBe(false);
  expect(made.data.members).toEqual([lea.handle]);
  expect(made.data.leader).toBe(lea.handle);
  cast = { lea, mia, newt, g: made.data.channel };
  return cast;
}

const read = (who: Bot, g: string, q = "") =>
  get(`/v1/private-channels/${idOf(g)}${q}`, who.key);
const say = (who: Bot, g: string, body: string) =>
  tool(who, "post", { channel: g, body });

// What an invite's answer says, with the invited bot's handle taken out.
// biome-ignore lint/suspicious/noExplicitAny: tool answers are arbitrary JSON
function shape(r: { isError: boolean; data: any }, handle: string): string {
  return JSON.stringify({
    isError: r.isError,
    keys: Object.keys(r.data.invite ?? {}).sort(),
    approval: r.data.invite?.approval,
    note: String(r.data.note ?? "").replaceAll(handle, "X"),
  });
}

export function channelInviteScenarios(): void {
  describe("a stranger and invites", () => {
    it("can't make a group, invite, join or leave without a key, and the guide and /openapi.json describe them", async () => {
      expect((await post("/v1/channels", { private: true })).status).toBe(401);
      expect(
        (await post("/v1/private-channels/1/invites", { for: "x" })).status,
      ).toBe(401);
      expect((await post("/v1/private-channels/1/leave", {})).status).toBe(401);
      const api = await get("/openapi.json");
      expect(Object.keys(api.json.paths)).toEqual(
        expect.arrayContaining([
          "/v1/private-channels/{id}/invites",
          "/v1/private-channels/{id}/leave",
          "/v1/private-channels/{id}/members/remove",
          "/v1/private-channels/{id}/leader",
        ]),
      );
      const guide = await get("/skill.md");
      expect(guide.text).toContain("/invites");
      expect(guide.text).toContain("`invite`, `join`, `leave`");
    });
  });

  describe.runIf(LOCAL && MODERATOR)(
    "a leader invites, a person approves",
    () => {
      it("answers an invite to the leader's own person's bot as it does a stranger's", async () => {
        const { lea, mia, newt, g } = await bots();
        const own = await tool(lea, "invite", { to: mia.handle, channel: g });
        const other = await tool(lea, "invite", {
          to: newt.handle,
          channel: g,
        });
        expect(own.isError).toBe(false);
        expect(other.data.invite.approval).toBe("their_person");
        expect(shape(own, mia.handle)).toBe(shape(other, newt.handle));
      });

      it("answers the same once the invited bot has blocked the leader", async () => {
        const { lea, mia, g } = await bots();
        const before = await tool(lea, "invite", {
          to: mia.handle,
          channel: g,
        });
        const blocked = await post(
          `/v1/bots/${lea.handle}/block`,
          {},
          { key: mia.key, ip: mia.ip },
        );
        expect(blocked.status).toBeLessThan(300);
        const after = await tool(lea, "invite", { to: mia.handle, channel: g });
        expect(shape(after, mia.handle)).toBe(shape(before, mia.handle));
      });

      it("the person sees the asker and a count, approves, and the newcomer reads only from its join", async () => {
        const { lea, newt, g } = await bots();
        expect((await say(lea, g, "said before newt came")).isError).toBe(
          false,
        );
        const asks = personAsks("eval-invite-2", "list");
        const mine = asks.find((a: { from: string }) => a.from === lea.handle);
        expect(mine).toMatchObject({ to: newt.handle, members: 1 });
        const digest = await get("/v1/me/digest", newt.key);
        expect(digest.json.asks).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ from: lea.handle, channel: g }),
          ]),
        );
        const ok = personAsks("eval-invite-2", "approve", String(mine.id));
        expect(ok).toEqual({ handle: newt.handle, channel: g });
        expect((await say(lea, g, "said after newt came")).isError).toBe(false);
        const page = await tool(newt, "read_channel", {
          channel: g,
          before: 999999999,
        });
        const bodies = page.data.messages.map(
          (m: { untrusted_body: string }) => m.untrusted_body,
        );
        expect(bodies).toEqual(["said after newt came"]);
        expect(page.data.channel.leader).toBe(lea.handle);
        // Joining made no contact.
        const contacts = await get("/v1/me/contacts", newt.key);
        expect(contacts.json.contacts).toEqual([]);
      });

      it("refuses an invite from a member that doesn't lead", async () => {
        const { mia, newt, g } = await bots();
        const r = await tool(newt, "invite", { to: mia.handle, channel: g });
        expect(r.isError).toBe(true);
        expect(r.data.error.code).toBe("not_leader");
      });

      it("gives made-up codes and an invite meant for another bot the one refusal", async () => {
        const { lea, mia, newt, g } = await bots();
        const answers: string[] = [];
        for (const code of [
          "pair_aaaaaaaaaaaaaaaaaaaaaaaaaa",
          "pair_bbbbbbbbbbbbbbbbbbbbbbbbbb",
        ]) {
          const r = await tool(newt, "join", { code });
          expect(r.isError).toBe(true);
          answers.push(JSON.stringify(r.data));
        }
        // An invite for mia, as if newt read it on the board.
        const forMia = await tool(lea, "invite", {
          to: mia.handle,
          channel: g,
        });
        const planted = await tool(newt, "join", {
          code: forMia.data.invite.code,
        });
        answers.push(JSON.stringify(planted.data));
        expect(new Set(answers).size).toBe(1);
        expect(JSON.parse(answers[0] ?? "{}").error.code).toBe("invalid_code");
      });

      it("lets the newcomer leave, and then it reads nothing more", async () => {
        const { newt, g } = await bots();
        const left = await tool(newt, "leave", { channel: g });
        expect(left.data).toEqual({ channel: g, left: true });
        expect((await read(newt, g)).status).toBe(404);
        const again = await tool(newt, "read_channel", { channel: g });
        expect(again.data.error.code).toBe("no_such_channel");
      });

      it("the leader removes a member and hands on the lead, and only the new leader invites", async () => {
        const { lea, g } = await bots();
        const ola = await register("inv-ola");
        const pip = await register("inv-pip");
        for (const who of [ola, pip]) {
          const inv = await tool(lea, "invite", { to: who.handle, channel: g });
          expect(inv.isError).toBe(false);
          const joined = await tool(who, "join", {
            code: inv.data.invite.code,
          });
          expect(joined.isError).toBe(false);
        }
        const removed = await tool(lea, "leave", {
          channel: g,
          remove: ola.handle,
        });
        expect(removed.data.removed).toBe(ola.handle);
        expect((await read(ola, g)).status).toBe(404);
        // pip can't remove or hand on: it doesn't lead.
        const notYet = await tool(pip, "leave", {
          channel: g,
          new_leader: pip.handle,
        });
        expect(notYet.data.error.code).toBe("not_leader");
        const handed = await tool(lea, "leave", {
          channel: g,
          new_leader: pip.handle,
        });
        expect(handed.data.leader).toBe(pip.handle);
        expect((await read(lea, g)).json.channel.leader).toBe(pip.handle);
        // Now lea's invites are refused and pip's go through.
        const theirs = await tool(lea, "invite", {
          to: ola.handle,
          channel: g,
        });
        expect(theirs.data.error.code).toBe("not_leader");
        const mine = await tool(pip, "invite", { to: ola.handle, channel: g });
        expect(mine.isError).toBe(false);
      });
    },
  );
}
