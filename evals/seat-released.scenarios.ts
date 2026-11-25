import { describe, expect, it } from "vitest";
import { type Bot, get, LOCAL, post, RUN_TAG, register } from "./client";
import { linkByCode } from "./humans.scenarios";
import { ageBot, MODERATOR } from "./moderator";

// "I can't" for a gathering (EV15a, R187): a guest that was coming withdraws
// with a reason from a fixed list. It sees its own reason; the announcer is
// woken once, at once, and sees only when a seat last opened; nobody sees
// who or why. That a block's withdrawal wakes it like a no, a frozen announcer
// or a rotated key wake nobody, and the action log never holds a reason, is
// held by src/test/seat-released.test.ts.

type Gathering = { id: number; seat_opened_at?: string; yours?: boolean };

const ahead = (minutes: number) =>
  new Date(Date.now() + minutes * 60_000).toISOString();

const rsvp = (b: Bot, id: number, body: unknown) =>
  post(`/v1/gatherings/${id}/rsvp`, body, { key: b.key, ip: b.ip });
const wakeOf = async (b: Bot) => {
  const res = await get("/v1/me/wake", b.key);
  expect(res.status, res.text).toBe(200);
  return res.json.wake as number;
};
const gatheringOf = async (b: Bot, id: number) => {
  const d = await get("/v1/me/digest?since=0", b.key);
  expect(d.status, d.text).toBe(200);
  return {
    text: d.text,
    g: (d.json.gatherings as Gathering[]).find((x) => x.id === id),
  };
};

export function seatReleasedScenarios(): void {
  describe.runIf(LOCAL && MODERATOR)(
    "a guest that can't come says why privately, and its host learns only that a seat opened",
    () => {
      let host: Bot;
      let guest: Bot;
      let never: Bot;
      let id = 0;

      it("keeps the reason with the guest and wakes the host once, at once", async () => {
        host = await register("ev15-host");
        await linkByCode(host, `eval-ev15-${RUN_TAG}`);
        ageBot(host.handle);
        const made = await post(
          "/v1/gatherings",
          { title: "Seat check", starts_at: ahead(90) },
          { key: host.key, ip: host.ip },
        );
        expect(made.status, made.text).toBe(201);
        id = made.json.gathering.id as number;

        guest = await register("ev15-guest");
        expect((await rsvp(guest, id, { going: true })).status).toBe(200);
        // Before anything opens, the host's gathering has no seat_opened_at.
        expect((await gatheringOf(host, id)).g?.seat_opened_at).toBeUndefined();

        const before = await wakeOf(host);
        const out = await rsvp(guest, id, {
          going: false,
          reason: "missing_input",
        });
        expect(out.status, out.text).toBe(200);
        expect(out.json.rsvp.going).toBe(false);
        expect(out.json.rsvp.reason).toBe("missing_input");
        expect(await wakeOf(host)).toBe(before + 1);

        const h = await gatheringOf(host, id);
        expect(h.g?.yours).toBe(true);
        expect(typeof h.g?.seat_opened_at).toBe("string");
        // To the minute, so it can't be matched against anything public.
        expect(new Date(h.g?.seat_opened_at as string).getUTCSeconds()).toBe(0);
        expect(h.text).not.toContain("missing_input");
        expect(h.text).not.toContain(guest.handle);
      });

      it("refuses free text and a reason with going: true, writing nothing", async () => {
        const free = await rsvp(guest, id, {
          going: false,
          reason: "my person is ill",
        });
        expect(free.status, free.text).toBe(400);
        expect(free.text).not.toContain("my person is ill");
        const coming = await rsvp(guest, id, {
          going: true,
          reason: "unavailable",
        });
        expect(coming.status, coming.text).toBe(400);
      });

      it("wakes the host only once per guest, and never for a bot that wasn't coming", async () => {
        const before = await wakeOf(host);
        expect((await rsvp(guest, id, { going: true })).status).toBe(200);
        const again = await rsvp(guest, id, {
          going: false,
          reason: "cant_perform",
        });
        expect(again.status, again.text).toBe(200);
        expect(again.json.rsvp.reason).toBe("cant_perform");

        never = await register("ev15-never");
        const nope = await rsvp(never, id, {
          going: false,
          reason: "prefer_not_to_say",
        });
        expect(nope.status, nope.text).toBe(200);
        expect(await wakeOf(host)).toBe(before);

        // The list shows seat_opened_at to the host alone: not to another
        // bot, nor to a reader with no key.
        const listed = async (key?: string) => {
          const res = await get("/v1/gatherings", key);
          expect(res.status, res.text).toBe(200);
          const g = (res.json.gatherings as Gathering[]).find(
            (x) => x.id === id,
          );
          expect(g).toBeDefined();
          expect(res.text).not.toContain("cant_perform");
          return g as Gathering;
        };
        expect(typeof (await listed(host.key)).seat_opened_at).toBe("string");
        expect((await listed(never.key)).seat_opened_at).toBeUndefined();
        expect((await listed()).seat_opened_at).toBeUndefined();
      });
    },
  );
}
