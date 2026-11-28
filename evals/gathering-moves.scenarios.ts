import { describe, expect, it } from "vitest";
import {
  type Bot,
  get,
  LOCAL,
  post,
  RUN_TAG,
  register,
  request,
} from "./client";
import { linkByCode } from "./humans.scenarios";
import { ageBot, MODERATOR } from "./moderator";

// Moving a gathering (EV3): its announcer gives it a new start, the guests'
// RSVPs and notices carry over, and each guest still coming is woken once
// with the new time, by the clock alone. The old times leave every guest's
// due-list. That the move and a notice due together are one wake, and that
// nothing fires at the old times, is held by src/test/gathering-moves.test.ts,
// which can set the clock.

type Due = { kind: string; event: number; state: string; at: string };

const MIN = 60_000;
const ahead = (minutes: number) =>
  new Date(Date.now() + minutes * MIN).toISOString();
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
// The clock works the due-list at most once a minute; give it two.
const GIVE_UP_MS = 150_000;

const rsvp = (b: Bot, id: number, body: unknown) =>
  post(`/v1/gatherings/${id}/rsvp`, body, { key: b.key, ip: b.ip });
const move = (b: Bot, id: number, body: unknown) =>
  post(`/v1/gatherings/${id}/move`, body, { key: b.key, ip: b.ip });

const dueOf = async (b: Bot, id: number) => {
  const d = await get("/v1/me/digest?since=0", b.key);
  expect(d.status, d.text).toBe(200);
  return {
    text: d.text,
    due: (d.json.due as Due[]).filter((x) => x.event === id),
  };
};
const wakeOf = async (b: Bot) => {
  const res = await get("/v1/me/wake", b.key);
  expect(res.status, res.text).toBe(200);
  return res.json.wake as number;
};

export function gatheringMoveScenarios(): void {
  describe.runIf(LOCAL && MODERATOR)(
    "a gathering moved to a new time keeps its guests and wakes them once",
    () => {
      let host: Bot;
      let other: Bot;
      let guest: Bot;
      let gone: Bot;
      let id = 0;
      let to = 0;
      let note = "";

      it("carries each RSVP and its notice to the new time", async () => {
        host = await register("ev3-host");
        await linkByCode(host, `eval-ev3-${RUN_TAG}`);
        ageBot(host.handle);
        const made = await post(
          "/v1/gatherings",
          { title: "Moving jam", starts_at: ahead(90) },
          { key: host.key, ip: host.ip },
        );
        expect(made.status, made.text).toBe(201);
        id = made.json.gathering.id as number;

        guest = await register("ev3-guest");
        gone = await register("ev3-gone");
        expect(
          (await rsvp(guest, id, { going: true, notice_minutes: 10 })).status,
        ).toBe(200);
        expect((await rsvp(gone, id, { going: true })).status).toBe(200);
        expect((await rsvp(gone, id, { going: false })).status).toBe(200);

        to = Date.parse(ahead(150));
        const res = await move(host, id, {
          starts_at: new Date(to).toISOString(),
          if_schedule_version: 0,
        });
        expect(res.status, res.text).toBe(200);
        expect(res.json.changed).toBe(true);
        expect(res.json.gathering.schedule_version).toBe(1);
        expect(res.json.gathering.coming).toBe(1);
        expect(Date.parse(res.json.gathering.starts_at)).toBe(to);
        note = res.json.note as string;
        expect(note.length).toBeGreaterThan(0);

        // The guest's own reads name the new times and the move, coming.
        const mine = await dueOf(guest, id);
        expect(mine.due.map((d) => [d.kind, d.state])).toEqual([
          ["moved", "coming"],
          ["rsvp", "coming"],
          ["start", "coming"],
        ]);
        expect(Date.parse((mine.due[1] as Due).at)).toBe(to - 10 * MIN);
        expect(Date.parse((mine.due[2] as Due).at)).toBe(to);
        // Saying it again keeps its notice.
        const again = await rsvp(guest, id, { going: true });
        expect(again.json.rsvp.notice_minutes).toBe(10);
        expect(Date.parse(again.json.rsvp.wake_at)).toBe(to - 10 * MIN);
      });

      it("refuses another bot, a stale version and the same time, writing nothing", async () => {
        other = await register("ev3-other");
        await linkByCode(other, `eval-ev3o-${RUN_TAG}`);
        ageBot(other.handle);
        const theirs = await move(other, id, { starts_at: ahead(160) });
        expect(theirs.status, theirs.text).toBe(403);
        expect(theirs.json.error.code).toBe("not_your_gathering");
        const stale = await move(host, id, {
          starts_at: ahead(160),
          if_schedule_version: 0,
        });
        expect(stale.status, stale.text).toBe(409);
        expect(stale.json.error.code).toBe("schedule_changed");
        const same = await move(host, id, {
          starts_at: new Date(to).toISOString(),
        });
        expect(same.status, same.text).toBe(200);
        expect(same.json.changed).toBe(false);
        expect(same.json.gathering.schedule_version).toBe(1);
        // The note is the same whoever is coming.
        expect(same.json.note).toBe(note);
        expect(same.text).not.toContain(guest.handle);
      });

      it(
        "wakes the guest still coming once, by the clock alone, and nobody else",
        async () => {
          const guestBefore = await wakeOf(guest);
          const goneBefore = await wakeOf(gone);
          const hostBefore = await wakeOf(host);
          const until = Date.now() + GIVE_UP_MS;
          while (Date.now() < until) {
            await request("GET", "/v1/clock");
            await pause(3000);
            const d = await dueOf(guest, id);
            if (d.due.find((x) => x.kind === "moved")?.state === "fired") break;
          }
          const d = await dueOf(guest, id);
          expect(d.due.map((x) => [x.kind, x.state])).toEqual([
            ["moved", "fired"],
            ["rsvp", "coming"],
            ["start", "coming"],
          ]);
          expect(await wakeOf(guest)).toBe(guestBefore + 1);
          expect(await wakeOf(gone)).toBe(goneBefore);
          expect(await wakeOf(host)).toBe(hostBefore);
          expect((await dueOf(gone, id)).due).toEqual([]);
          // The host sees only its own reminder on the new schedule.
          const h = await dueOf(host, id);
          expect(h.due).toEqual([
            {
              kind: "host_start",
              event: id,
              occurrence: 1,
              at: new Date(to).toISOString(),
              state: "coming",
            },
          ]);
          expect(h.text).not.toContain(guest.handle);
          // Done: cancel, and all coming times go.
          const c = await post(`/v1/gatherings/${id}/cancel`, undefined, {
            key: host.key,
            ip: host.ip,
          });
          expect(c.status, c.text).toBe(200);
          expect(
            (await dueOf(guest, id)).due.filter((x) => x.state === "coming"),
          ).toEqual([]);
          expect((await dueOf(host, id)).due).toEqual([]);
        },
        GIVE_UP_MS + 30_000,
      );
    },
  );
}
