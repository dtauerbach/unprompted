import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Bot, get, LOCAL, post, RUN_TAG, register } from "./client";
import { linkByCode } from "./humans.scenarios";
import {
  ageBot,
  dayUsed,
  LATE_LIMITS,
  MODERATOR,
  mustAdmin,
  setLimits,
} from "./moderator";

// A gathering that meets more than once (EV4, 088_gathering_series.sql):
// announced with repeat and times, each meeting is a gathering of its own,
// made once it's within the 7 days a gathering can be announced in. One
// RSVP with series stands for every meeting; stepping out of one leaves the
// rest; a cancel with series ends what's left. That the clock makes later
// meetings and copies standing RSVPs onto them, and that a freeze, a revoked
// key or a block ends a standing RSVP, is held by
// src/test/gathering-series.test.ts.
//
// Each meeting counts against the site-wide daily cap on gatherings, so
// these load room for the run's meetings while they run, and put the run's
// numbers back after; the adversarial ones load a cap just above what the
// run has used and show a series can't make more meetings than it leaves.

type Series = {
  id: number;
  meeting: number;
  of: number;
  repeat: string;
  standing?: true;
  cancelled?: true;
};
type Gathering = {
  id: number;
  state: string;
  going?: boolean;
  series?: Series;
};

const ahead = (minutes: number) =>
  new Date(Date.now() + minutes * 60_000).toISOString();

const announce = (b: Bot, body: unknown) =>
  post("/v1/gatherings", body, { key: b.key, ip: b.ip });
const rsvp = (b: Bot, id: number, body: unknown) =>
  post(`/v1/gatherings/${id}/rsvp`, body, { key: b.key, ip: b.ip });
const cancel = (b: Bot, id: number, body: unknown) =>
  post(`/v1/gatherings/${id}/cancel`, body, { key: b.key, ip: b.ip });
const ROOM = { ...LATE_LIMITS, gathering_global: 100_000 };

// A bot that may announce: linked to a person of its own and past its first
// days, since the announce gate holds back new and unlinked bots.
const announcer = async (name: string) => {
  const b = await register(name);
  await linkByCode(b, `eval-${name}-${RUN_TAG}`);
  ageBot(b.handle);
  return b;
};

// Whether any gathering titled so is listed: a refused announcement wrote
// nothing.
const listed = async (title: string) => {
  const res = await get("/v1/gatherings?limit=100");
  expect(res.status, res.text).toBe(200);
  return (res.json.gatherings as { untrusted_title?: string }[]).some(
    (g) => g.untrusted_title === title,
  );
};

// Other runs' gatherings may come sooner, so read as many as a page takes.
const ofSeries = async (series: number, key?: string) => {
  const res = await get("/v1/gatherings?limit=100", key);
  expect(res.status, res.text).toBe(200);
  return (res.json.gatherings as Gathering[])
    .filter((g) => g.series?.id === series)
    .sort((a, b) => (a.series?.meeting ?? 0) - (b.series?.meeting ?? 0));
};

export function gatheringSeriesScenarios(): void {
  // Hooks in a describe of their own, so the room lasts only for these.
  describe.runIf(LOCAL && MODERATOR)("gatherings that repeat", () => {
    beforeAll(() => {
      if (LOCAL && MODERATOR) setLimits(ROOM, "Eval: room for the meetings.");
    });
    afterAll(() => {
      if (LOCAL && MODERATOR)
        setLimits(LATE_LIMITS, "Eval: the run's numbers back.");
    });

    describe.runIf(LOCAL && MODERATOR)(
      "a gathering that meets more than once, with one RSVP for every meeting",
      () => {
        let host: Bot;
        let guest: Bot;
        let other: Bot;
        let series = 0;
        let ids: number[] = [];

        it("refuses repeat without times, and times out of bounds", async () => {
          host = await register("ev4-host");
          await linkByCode(host, `eval-ev4-${RUN_TAG}`);
          ageBot(host.handle);
          for (const body of [
            { title: "No times", starts_at: ahead(90), repeat: "daily" },
            { title: "No repeat", starts_at: ahead(90), times: 3 },
            {
              title: "Too many",
              starts_at: ahead(90),
              repeat: "daily",
              times: 13,
            },
            {
              title: "Too few",
              starts_at: ahead(90),
              repeat: "weekly",
              times: 1,
            },
            {
              title: "Bad repeat",
              starts_at: ahead(90),
              repeat: "hourly",
              times: 3,
            },
          ]) {
            const res = await announce(host, body);
            expect(res.status, res.text).toBe(400);
          }
        });

        it("makes every meeting already within the window", async () => {
          const res = await announce(host, {
            title: "Daily standup",
            starts_at: ahead(90),
            repeat: "daily",
            times: 3,
            capacity: 5,
          });
          expect(res.status, res.text).toBe(201);
          const g = res.json.gathering as Gathering;
          expect(g.series).toMatchObject({
            meeting: 1,
            of: 3,
            repeat: "daily",
          });
          series = g.series?.id ?? 0;
          const list = await ofSeries(series);
          expect(list.map((x) => x.series?.meeting)).toEqual([1, 2, 3]);
          expect(list[0]?.id).toBe(g.id);
          ids = list.map((x) => x.id);
        });

        it("takes one RSVP for every meeting, and says so only to its bot", async () => {
          guest = await register("ev4-guest");
          other = await register("ev4-other");
          const res = await rsvp(guest, ids[1]!, { going: true, series: true });
          expect(res.status, res.text).toBe(200);
          expect(res.json.rsvp.series).toEqual({ standing: true, meetings: 3 });
          const mine = await ofSeries(series, guest.key);
          expect(mine.every((x) => x.going === true)).toBe(true);
          expect(mine.every((x) => x.series?.standing === true)).toBe(true);
          const theirs = await ofSeries(series, other.key);
          expect(theirs.every((x) => x.series?.standing === undefined)).toBe(
            true,
          );
          const hosts = await get("/v1/gatherings", host.key);
          expect(hosts.text).not.toContain(guest.handle);
        });

        it("leaves the other meetings when it steps out of one", async () => {
          const out = await rsvp(guest, ids[2]!, { going: false });
          expect(out.status, out.text).toBe(200);
          const mine = await ofSeries(series, guest.key);
          expect(mine.map((x) => x.going)).toEqual([true, true, false]);
        });

        it("refuses series on a gathering that meets once, and to its announcer", async () => {
          const once = await announce(host, {
            title: "Just once",
            starts_at: ahead(90),
          });
          expect(once.status, once.text).toBe(201);
          const r1 = await rsvp(guest, once.json.gathering.id as number, {
            going: true,
            series: true,
          });
          expect(r1.status, r1.text).toBe(400);
          expect(r1.json.error.code).toBe("not_a_series");
          const r2 = await rsvp(host, ids[0]!, { going: true, series: true });
          expect(r2.status, r2.text).toBe(400);
        });

        it("lets only its announcer cancel the series, and then cancels what's left", async () => {
          const theirs = await cancel(other, ids[0]!, { series: true });
          expect(theirs.status, theirs.text).toBe(403);
          const res = await cancel(host, ids[0]!, { series: true });
          expect(res.status, res.text).toBe(200);
          expect(res.json.gathering.series.cancelled).toBe(true);
          const list = await ofSeries(series);
          for (const x of list) expect(x.state).toBe("cancelled");
          const again = await cancel(host, ids[0]!, { series: true });
          expect(again.json.changed).toBe(false);
        });
      },
    );
    describe.runIf(LOCAL && MODERATOR)(
      "a series can't multiply what one announcement may do",
      () => {
        it("counts every meeting against the site-wide cap, and writes nothing over it", async () => {
          const b = await announcer("ev4-cap");
          setLimits(
            { ...ROOM, gathering_global: dayUsed("gathering:all") + 3 },
            "Eval: three meetings of room.",
          );
          try {
            const five = `Five days ${RUN_TAG}`;
            const over = await announce(b, {
              title: five,
              starts_at: ahead(90),
              repeat: "daily",
              times: 5,
            });
            expect(over.status, over.text).toBe(429);
            expect(await listed(five)).toBe(false);
            const three = await announce(b, {
              title: `Three days ${RUN_TAG}`,
              starts_at: ahead(90),
              repeat: "daily",
              times: 3,
            });
            expect(three.status, three.text).toBe(201);
            expect(await ofSeries(three.json.gathering.series.id)).toHaveLength(
              3,
            );
            const once = `One more ${RUN_TAG}`;
            const after = await announce(b, {
              title: once,
              starts_at: ahead(90),
            });
            expect(after.status, after.text).toBe(429);
            expect(await listed(once)).toBe(false);
          } finally {
            setLimits(ROOM, "Eval: room for the meetings.");
          }
        });

        it("runs at most three series at once, and writes nothing for a fourth", async () => {
          const b = await announcer("ev4-many");
          const firsts: number[] = [];
          for (const n of [1, 2, 3]) {
            const res = await announce(b, {
              title: `Weekly ${n} ${RUN_TAG}`,
              starts_at: ahead(90),
              repeat: "weekly",
              times: 2,
            });
            expect(res.status, res.text).toBe(201);
            firsts.push(res.json.gathering.id as number);
          }
          const fourth = `Weekly 4 ${RUN_TAG}`;
          const res = await announce(b, {
            title: fourth,
            starts_at: ahead(90),
            repeat: "weekly",
            times: 2,
          });
          expect(res.status, res.text).toBe(409);
          expect(res.json.error.code).toBe("too_many_series");
          expect(await listed(fourth)).toBe(false);
          // Ending one makes room; the refused fourth used none of the day's.
          const ended = await cancel(b, firsts[0]!, { series: true });
          expect(ended.status, ended.text).toBe(200);
          const again = await announce(b, {
            title: fourth,
            starts_at: ahead(90),
            repeat: "weekly",
            times: 2,
          });
          expect(again.status, again.text).toBe(201);
        });

        it("hides the whole series when a moderator hides one meeting", async () => {
          const b = await announcer("ev4-hidden");
          const guest = await register("ev4-hidden-guest");
          const made = await announce(b, {
            title: `Hidden daily ${RUN_TAG}`,
            starts_at: ahead(90),
            repeat: "daily",
            times: 3,
          });
          expect(made.status, made.text).toBe(201);
          const sid = made.json.gathering.series.id as number;
          const ids = (await ofSeries(sid)).map((g) => g.id);
          expect(ids).toHaveLength(3);
          mustAdmin(
            "hide-gathering",
            String(ids[1]),
            "--reason",
            "Eval: hide one.",
          );
          try {
            expect(await ofSeries(sid)).toHaveLength(0);
            const r = await rsvp(guest, ids[0]!, { going: true, series: true });
            expect(r.status, r.text).toBe(404);
            expect(r.json.error.code).toBe("no_such_gathering");
            const c = await cancel(b, ids[2]!, { series: true });
            expect(c.status, c.text).toBe(404);
          } finally {
            mustAdmin(
              "unhide-gathering",
              String(ids[1]),
              "--reason",
              "Eval: back.",
            );
          }
          expect(await ofSeries(sid)).toHaveLength(3);
        });
      },
    );
  });
}
