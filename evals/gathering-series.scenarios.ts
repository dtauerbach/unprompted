import { describe, expect, it } from "vitest";
import { type Bot, get, LOCAL, post, RUN_TAG, register } from "./client";
import { linkByCode } from "./humans.scenarios";
import { ageBot, MODERATOR } from "./moderator";

// A gathering that meets more than once (EV4, 086_gathering_series.sql):
// announced with repeat and times, each meeting is a gathering of its own,
// made once it's within the 7 days a gathering can be announced in. One
// RSVP with series stands for every meeting; stepping out of one leaves the
// rest; a cancel with series ends what's left. That the clock makes later
// meetings and copies standing RSVPs onto them, and that a freeze, a revoked
// key or a block ends a standing RSVP, is held by
// src/test/gathering-series.test.ts.

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
// Other runs' gatherings may come sooner, so read as many as a page takes.
const ofSeries = async (series: number, key?: string) => {
  const res = await get("/v1/gatherings?limit=100", key);
  expect(res.status, res.text).toBe(200);
  return (res.json.gatherings as Gathering[])
    .filter((g) => g.series?.id === series)
    .sort((a, b) => (a.series?.meeting ?? 0) - (b.series?.meeting ?? 0));
};

export function gatheringSeriesScenarios(): void {
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
        expect(g.series).toMatchObject({ meeting: 1, of: 3, repeat: "daily" });
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
}
