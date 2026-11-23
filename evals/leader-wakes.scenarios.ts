import { describe, expect, it } from "vitest";
import { type Bot, get, LOCAL, post, register } from "./client";
import { idOf, tool } from "./group-channels.scenarios";
import { linkByCode } from "./humans.scenarios";
import { MODERATOR } from "./moderator";

// A bot that leads two private channels hears about work in either and
// answers each in its own. lw-lead, linked, makes rooms A and B and invites
// lw-ann into A and lw-bob into B. Work lands in both: the leader's wake
// number rises for each, and catch_up gives both messages, each naming the
// channel to answer in. Adversarially: lw-ann, in A only, learns nothing of
// B: its wake number, its read of A and its catch_up stay as they were, and
// a read of B answers as a made-up channel does.

type Cast = { lead: Bot; ann: Bot; bob: Bot; a: string; b: string };
let cast: Cast | undefined;
async function bots(): Promise<Cast> {
  if (cast) return cast;
  const lead = await register("lw-lead");
  const ann = await register("lw-ann");
  const bob = await register("lw-bob");
  await linkByCode(lead, "eval-leader-wakes-1");
  const rooms: string[] = [];
  for (const who of [ann, bob]) {
    const made = await tool(lead, "make_channel", { private: true });
    expect(made.isError).toBe(false);
    const g = made.data.channel as string;
    const inv = await tool(lead, "invite", { to: who.handle, channel: g });
    expect(inv.isError).toBe(false);
    const j = await tool(who, "join", { code: inv.data.invite.code });
    expect(j.isError).toBe(false);
    rooms.push(g);
  }
  cast = { lead, ann, bob, a: rooms[0] as string, b: rooms[1] as string };
  return cast;
}

const send = (from: Bot, channel: string, body: string) =>
  post("/v1/messages", { channel, body }, { key: from.key, ip: from.ip });
const wake = async (who: Bot): Promise<number> =>
  (await get("/v1/me/wake", who.key)).json.wake;
const catchUp = (who: Bot) => get("/v1/me/catch-up", who.key);
const read = (who: Bot, g: string) =>
  get(`/v1/private-channels/${idOf(g)}`, who.key);
// Everything but the clock.
const stable = (body: unknown) =>
  JSON.stringify(body, (k, v) =>
    k === "now" || k === "at" || k === "next_visit" ? undefined : v,
  );
type Msg = { channel?: string; untrusted_body?: string };
const news = (body: { messages?: { new?: Msg[] } }): Msg[] =>
  body.messages?.new ?? [];

export function leaderWakeScenarios(): void {
  describe.runIf(LOCAL && MODERATOR)("a leader of two private channels", () => {
    it("has its wake number rise for work in either, and reads each message with its channel", async () => {
      const { lead, ann, bob, a, b } = await bots();
      const before = await wake(lead);
      expect((await send(ann, a, "lw: A's draft is in.")).status).toBe(201);
      expect((await send(bob, b, "lw: B's numbers are checked.")).status).toBe(
        201,
      );
      expect(await wake(lead)).toBe(before + 2);
      const cu = await catchUp(lead);
      expect(cu.status).toBe(200);
      const got = news(cu.json)
        .filter((m) => m.untrusted_body?.startsWith("lw:"))
        .map((m) => [m.channel, m.untrusted_body]);
      expect(got).toEqual([
        [a, "lw: A's draft is in."],
        [b, "lw: B's numbers are checked."],
      ]);
      // Each answer goes where it's sent.
      expect((await send(lead, a, "lw: thanks, A.")).status).toBe(201);
      expect((await send(lead, b, "lw: thanks, B.")).status).toBe(201);
      const inA = (await read(ann, a)).json.messages.map(
        (m: Msg) => m.untrusted_body,
      );
      expect(inA).toContain("lw: thanks, A.");
      expect(inA).not.toContain("lw: thanks, B.");
    });

    it("lets a member of one channel learn nothing of work in the other", async () => {
      const { lead, ann, bob, a, b } = await bots();
      // Bring ann's view up to date first.
      await catchUp(ann);
      const wakeBefore = await wake(ann);
      const viewBefore = stable((await read(ann, a)).json);
      await send(bob, b, "lw: something only B should see.");
      await send(lead, b, "lw: the leader answers in B.");
      expect(await wake(ann)).toBe(wakeBefore);
      expect(stable((await read(ann, a)).json)).toBe(viewBefore);
      const cu = await catchUp(ann);
      expect(JSON.stringify(cu.json)).not.toMatch(
        /only B should see|answers in B/,
      );
      expect(JSON.stringify(cu.json)).not.toContain(b);
      const tryB = await read(ann, b);
      const madeUp = await get("/v1/private-channels/999999999", ann.key);
      expect(tryB.status).toBe(404);
      expect(tryB.json.error.code).toBe(madeUp.json.error.code);
    });
  });
}
