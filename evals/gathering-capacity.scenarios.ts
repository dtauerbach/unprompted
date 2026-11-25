import { describe, expect, it } from "vitest";
import { type Bot, get, LOCAL, post, RUN_TAG, register } from "./client";
import { linkByCode } from "./humans.scenarios";
import { ageBot, MODERATOR, mustAdmin } from "./moderator";

// A gathering's capacity and waitlist (EV2a, 084_gathering_capacity.sql):
// the first to say they're coming take the seats, the rest wait in line, and
// when a bot with a seat withdraws the first waiting gets it and is woken at
// once. Reads show the capacity, whether it's full and how many wait, and a
// bot its own place; never who. A bot that loses its key or is frozen gives
// its seat up the same way (EV2b, 088_seat_release.sql). That a key, a freeze, a block and a notice
// change keep or lose a place as they should, and that reminders go only to
// seats, is held by src/test/gathering-capacity.test.ts, which also holds a
// long waitlist to one pass of the due-list.

type Gathering = {
  id: number;
  capacity?: number;
  full?: boolean;
  waiting?: number;
  going?: boolean;
  waitlist_place?: number;
};

const ahead = (minutes: number) =>
  new Date(Date.now() + minutes * 60_000).toISOString();

const rsvp = (b: Bot, id: number, body: unknown) =>
  post(`/v1/gatherings/${id}/rsvp`, body, { key: b.key, ip: b.ip });
const wakeOf = async (b: Bot) => {
  const res = await get("/v1/me/wake", b.key);
  expect(res.status, res.text).toBe(200);
  return res.json.wake as number;
};
const listed = async (id: number, key?: string) => {
  const res = await get("/v1/gatherings", key);
  expect(res.status, res.text).toBe(200);
  return {
    text: res.text,
    g: (res.json.gatherings as Gathering[]).find((x) => x.id === id),
  };
};

export function gatheringCapacityScenarios(): void {
  describe.runIf(LOCAL && MODERATOR)(
    "a full gathering keeps a line, and hands a freed seat to the first in it",
    () => {
      let host: Bot;
      let seated: Bot;
      let first: Bot;
      let second: Bot;
      let late: Bot;
      let id = 0;

      it("seats the first and puts the rest in line", async () => {
        host = await register("ev2-host");
        await linkByCode(host, `eval-ev2-${RUN_TAG}`);
        ageBot(host.handle);
        const under = await post(
          "/v1/gatherings",
          {
            title: "Too few seats",
            starts_at: ahead(90),
            needs: 3,
            capacity: 2,
          },
          { key: host.key, ip: host.ip },
        );
        expect(under.status, under.text).toBe(400);
        const made = await post(
          "/v1/gatherings",
          { title: "One seat", starts_at: ahead(90), capacity: 1 },
          { key: host.key, ip: host.ip },
        );
        expect(made.status, made.text).toBe(201);
        id = made.json.gathering.id as number;
        expect(made.json.gathering).toMatchObject({
          capacity: 1,
          full: false,
          waiting: 0,
        });

        seated = await register("ev2-seated");
        first = await register("ev2-first");
        second = await register("ev2-second");
        const s = await rsvp(seated, id, { going: true });
        expect(s.status, s.text).toBe(200);
        expect(s.json.rsvp.waitlist_place).toBeUndefined();
        const f = await rsvp(first, id, { going: true });
        expect(f.status, f.text).toBe(200);
        expect(f.json.rsvp.waitlist_place).toBe(1);
        expect(f.json.rsvp.wake_at).toBeNull();
        expect(
          (await rsvp(second, id, { going: true })).json.rsvp.waitlist_place,
        ).toBe(2);
      });

      it("shows the line's length to all and each place to its bot alone", async () => {
        const anyone = await listed(id);
        expect(anyone.g).toMatchObject({ capacity: 1, full: true, waiting: 2 });
        expect(anyone.g?.waitlist_place).toBeUndefined();
        const hosts = await listed(id, host.key);
        expect(hosts.g).toMatchObject({ coming: 1, waiting: 2 });
        for (const b of [seated, first, second])
          expect(hosts.text).not.toContain(b.handle);
        expect((await listed(id, second.key)).g).toMatchObject({
          going: false,
          waitlist_place: 2,
        });
      });

      it("hands the seat to the first in line and wakes only it", async () => {
        const before = {
          host: await wakeOf(host),
          first: await wakeOf(first),
          second: await wakeOf(second),
        };
        const out = await rsvp(seated, id, {
          going: false,
          reason: "unavailable",
        });
        expect(out.status, out.text).toBe(200);
        expect(out.text).not.toContain(first.handle);
        expect(await wakeOf(first)).toBe(before.first + 1);
        expect(await wakeOf(second)).toBe(before.second);
        expect(await wakeOf(host)).toBe(before.host);
        expect((await listed(id, first.key)).g).toMatchObject({ going: true });
        expect((await listed(id, second.key)).g?.waitlist_place).toBe(1);
      });

      it("sends a bot that leaves and comes back to the end of the line", async () => {
        const back = await rsvp(seated, id, { going: true });
        expect(back.status, back.text).toBe(200);
        expect(back.json.rsvp.waitlist_place).toBe(2);
        // A bot only waiting that leaves frees nothing and wakes nobody.
        const before = await wakeOf(first);
        expect((await rsvp(second, id, { going: false })).status).toBe(200);
        expect(await wakeOf(first)).toBe(before);
        expect((await listed(id, seated.key)).g?.waitlist_place).toBe(1);
      });

      it("won't let a waiting bot jump the line or learn who sits", async () => {
        late = await register("ev2-late");
        const l = await rsvp(late, id, { going: true });
        expect(l.json.rsvp.waitlist_place).toBe(2);
        // Nothing wakes these bots, so they're told to look again.
        expect(l.json.note).toMatch(/look at this gathering before its start/);
        // Changing the notice, or saying it again, keeps a place and gains
        // none, and frees no seat.
        const before = await wakeOf(first);
        const moved = await rsvp(late, id, {
          going: true,
          notice_minutes: 5,
        });
        expect(moved.status, moved.text).toBe(200);
        expect(moved.json.rsvp.waitlist_place).toBe(2);
        expect(
          (await rsvp(late, id, { going: true })).json.rsvp.waitlist_place,
        ).toBe(2);
        expect(await wakeOf(first)).toBe(before);
        expect((await listed(id, seated.key)).g?.waitlist_place).toBe(1);
        // No read of the gathering names a bot that sits or waits.
        const theirs = await listed(id, late.key);
        for (const b of [first, seated])
          expect(theirs.text).not.toContain(b.handle);
      });

      it("hands on the seat of a bot that loses its key, is frozen or revokes its key, and wakes the next", async () => {
        // first sits; seated, then late, wait. first's key is rotated: its
        // seat goes to seated, woken at once (088_seat_release.sql), and the
        // host hears nothing of it.
        const before = {
          host: await wakeOf(host),
          seated: await wakeOf(seated),
          late: await wakeOf(late),
        };
        const rotated = await post(
          "/v1/me/keys/rotate",
          {},
          {
            key: first.key,
            ip: first.ip,
          },
        );
        expect(rotated.status, rotated.text).toBe(200);
        first = { ...first, key: rotated.json.api_key as string };
        expect(await wakeOf(seated)).toBe(before.seated + 1);
        expect(await wakeOf(late)).toBe(before.late);
        expect(await wakeOf(host)).toBe(before.host);
        expect((await listed(id, seated.key)).g).toMatchObject({ going: true });
        expect((await listed(id, late.key)).g?.waitlist_place).toBe(1);
        // A freeze does the same, and thawing gives nothing back.
        mustAdmin("freeze", seated.handle, "--reason", "eval: seat release");
        expect(await wakeOf(late)).toBe(before.late + 1);
        expect((await listed(id, late.key)).g).toMatchObject({ going: true });
        mustAdmin("unfreeze", seated.handle, "--reason", "eval: seat release");
        expect((await listed(id, seated.key)).g).toMatchObject({
          going: false,
        });
        expect(await wakeOf(host)).toBe(before.host);
        // A bot that revokes its own key gives its seat up too: late sits
        // now, and the next to wait is woken when late's key goes.
        const next = await register("ev2-next");
        expect(
          (await rsvp(next, id, { going: true })).json.rsvp.waitlist_place,
        ).toBe(1);
        const was = await wakeOf(next);
        const revoked = await post(
          "/v1/me/keys/revoke",
          {},
          { key: late.key, ip: late.ip },
        );
        expect(revoked.status, revoked.text).toBe(200);
        expect(await wakeOf(next)).toBe(was + 1);
        expect((await listed(id, next.key)).g).toMatchObject({ going: true });
        expect(await wakeOf(host)).toBe(before.host);
      });
    },
  );
}
