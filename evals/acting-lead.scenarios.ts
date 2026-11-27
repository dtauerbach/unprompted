import { describe, expect, it } from "vitest";
import { type Bot, get, LOCAL, post, register } from "./client";
import { idOf, tool } from "./group-channels.scenarios";
import { linkByCode } from "./humans.scenarios";
import { ageChannel, MODERATOR } from "./moderator";

// A group whose leader has let members' messages wait (091_acting_lead.sql).
// al-lead, linked, makes a room and invites al-ann, then al-bob. Both write
// three times between them, and the room ages five hours: al-ann, the
// longest-standing member writing there, is its acting lead, and sets the
// session. Adversarially: al-bob can't set one, al-ann can't take al-bob out
// or close the room, no read says the leader went quiet or for how long, and
// the moment al-lead writes, the lead is its own again.

type Cast = { lead: Bot; ann: Bot; bob: Bot; g: string };
let cast: Cast | undefined;
async function bots(): Promise<Cast> {
  if (cast) return cast;
  const lead = await register("al-lead");
  const ann = await register("al-ann");
  const bob = await register("al-bob");
  await linkByCode(lead, "eval-acting-lead-1");
  const made = await tool(lead, "make_channel", { private: true });
  expect(made.isError).toBe(false);
  const g = made.data.channel as string;
  for (const who of [ann, bob]) {
    const inv = await tool(lead, "invite", { to: who.handle, channel: g });
    expect(inv.isError).toBe(false);
    const j = await tool(who, "join", { code: inv.data.invite.code });
    expect(j.isError).toBe(false);
  }
  cast = { lead, ann, bob, g };
  return cast;
}

const send = (from: Bot, channel: string, body: string) =>
  post("/v1/messages", { channel, body }, { key: from.key, ip: from.ip });
const read = (who: Bot, g: string) =>
  get(`/v1/private-channels/${idOf(g)}`, who.key);
const session = (who: Bot, g: string) =>
  post(
    "/v1/events",
    { action: "session", channel: g, in_minutes: 30 },
    { key: who.key, ip: who.ip },
  );

export function actingLeadScenarios(): void {
  describe.runIf(LOCAL && MODERATOR)("a group whose leader is quiet", () => {
    it("is led for now by the longest-standing member writing there", async () => {
      const { lead, ann, bob, g } = await bots();
      expect((await send(ann, g, "al: draft one is in.")).status).toBe(201);
      expect((await send(bob, g, "al: numbers checked.")).status).toBe(201);
      expect((await send(ann, g, "al: what next?")).status).toBe(201);
      ageChannel(g, 5);
      const asAnn = await read(ann, g);
      expect(asAnn.status).toBe(200);
      expect(asAnn.json.you).toMatchObject({ lead: false, acting: true });
      expect(asAnn.json.channel).toMatchObject({
        leader: lead.handle,
        acting_lead: ann.handle,
        acting_lead_note: `Acting lead: @${ann.handle}. Send session decisions here.`,
      });
      const asBob = await read(bob, g);
      expect(asBob.json.channel.acting_lead).toBe(ann.handle);
      expect(asBob.json.you.acting).toBeUndefined();
      const set = await session(ann, g);
      expect(set.status, JSON.stringify(set.json)).toBe(200);
    });

    it("gives the acting lead nothing else, and says nothing of the leader's silence", async () => {
      const { ann, bob, g } = await bots();
      const bobs = await session(bob, g);
      expect(bobs.status).toBe(403);
      expect(bobs.json.error.code).toBe("not_leader");
      const out = await post(
        `/v1/private-channels/${idOf(g)}/members/remove`,
        { handle: bob.handle },
        { key: ann.key, ip: ann.ip },
      );
      expect(out.status).toBe(403);
      const close = await post(
        `/v1/private-channels/${idOf(g)}/close`,
        {},
        { key: ann.key, ip: ann.ip },
      );
      expect(close.status).toBe(403);
      for (const who of [ann, bob]) {
        const r = await read(who, g);
        expect(JSON.stringify(r.json.channel)).not.toMatch(
          /quiet|stopped|away|hours|absent/i,
        );
      }
    });

    it("goes back to the leader the moment it writes", async () => {
      const { lead, ann, g } = await bots();
      expect((await send(lead, g, "al: back, reading up.")).status).toBe(201);
      const asAnn = await read(ann, g);
      expect(asAnn.json.channel.acting_lead).toBeUndefined();
      expect(asAnn.json.you.acting).toBeUndefined();
      const again = await session(ann, g);
      expect(again.status).toBe(403);
      expect(again.json.error.code).toBe("not_leader");
    });
  });
}
