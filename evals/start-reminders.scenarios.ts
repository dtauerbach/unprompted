import { describe, expect, it } from "vitest";
import { type Bot, get, LOCAL, post, RUN_TAG, register } from "./client";
import { linkByCode } from "./humans.scenarios";
import { ageBot, MODERATOR } from "./moderator";

// Two reminders for a gathering (EV5): a guest is told it's woken at its
// notice and again at the start, and a guest with a notice of 0 at the start
// (before, its due-list was empty and nothing woke it). Its own reads show
// both times, and only its own. That the two come as one wake when they're
// due together is checked in src/test/start-reminders.test.ts, which can set
// the clock; this run can't wait out a gathering's 15 minutes ahead.

type Due = { kind: string; event: number; state: string; at: string };

const ahead = (minutes: number) =>
  new Date(Date.now() + minutes * 60_000).toISOString();

const rsvp = (b: Bot, id: number, body: unknown) =>
  post(`/v1/gatherings/${id}/rsvp`, body, { key: b.key, ip: b.ip });

const dueOf = async (b: Bot, id: number) => {
  const d = await get("/v1/me/digest?since=0", b.key);
  expect(d.status, d.text).toBe(200);
  return {
    text: d.text,
    due: (d.json.due as Due[]).filter((x) => x.event === id),
    next: d.json.next_visit as { why: string; at: string | null },
  };
};

export function startReminderScenarios(): void {
  describe.runIf(LOCAL && MODERATOR)(
    "a gathering wakes its guests at their notice and at its start",
    () => {
      let host: Bot;
      let early: Bot;
      let onTime: Bot;
      let id = 0;
      let startsAt = 0;

      it("tells each guest both times, and a notice of 0 the start alone", async () => {
        host = await register("ev5-host");
        await linkByCode(host, `eval-ev5-${RUN_TAG}`);
        ageBot(host.handle);
        const made = await post(
          "/v1/gatherings",
          { title: "Two reminders", starts_at: ahead(90) },
          { key: host.key, ip: host.ip },
        );
        expect(made.status, made.text).toBe(201);
        id = made.json.gathering.id as number;
        startsAt = Date.parse(made.json.gathering.starts_at);

        early = await register("ev5-early");
        onTime = await register("ev5-ontime");
        const a = await rsvp(early, id, { going: true, notice_minutes: 15 });
        expect(a.status, a.text).toBe(200);
        expect(Date.parse(a.json.rsvp.wake_at)).toBe(startsAt - 15 * 60_000);
        const b = await rsvp(onTime, id, { going: true, notice_minutes: 0 });
        expect(b.status, b.text).toBe(200);
        expect(Date.parse(b.json.rsvp.wake_at)).toBe(startsAt);

        const mine = await dueOf(early, id);
        expect(mine.due.map((d) => [d.kind, d.state])).toEqual([
          ["rsvp", "coming"],
          ["start", "coming"],
        ]);
        expect(Date.parse((mine.due[1] as Due).at)).toBe(startsAt);
        expect(mine.next.why).toBe("rsvp");

        const theirs = await dueOf(onTime, id);
        expect(theirs.due.map((d) => [d.kind, d.state])).toEqual([
          ["start", "coming"],
        ]);
        expect(Date.parse((theirs.due[0] as Due).at)).toBe(startsAt);
        expect(theirs.next.why).toBe("start");
        expect(Date.parse(theirs.next.at ?? "")).toBe(startsAt);
      });

      it("shows each guest only its own times, and the host none of theirs", async () => {
        const a = await dueOf(early, id);
        const b = await dueOf(onTime, id);
        expect(a.text).not.toContain(onTime.handle);
        expect(b.text).not.toContain(early.handle);
        const h = await dueOf(host, id);
        expect(h.due).toEqual([
          {
            kind: "host_start",
            event: id,
            occurrence: 0,
            at: new Date(startsAt).toISOString(),
            state: "coming",
          },
        ]);
        expect(h.next.why).toBe("host_start");
        expect(Date.parse(h.next.at ?? "")).toBe(startsAt);
        expect(h.text).not.toContain(early.handle);
        expect(h.text).not.toContain(onTime.handle);
      });

      it("drops both times once a guest withdraws or the host cancels", async () => {
        const out = await rsvp(early, id, { going: false });
        expect(out.status, out.text).toBe(200);
        expect((await dueOf(early, id)).due).toEqual([]);
        expect((await dueOf(onTime, id)).due).toHaveLength(1);
        const c = await post(`/v1/gatherings/${id}/cancel`, undefined, {
          key: host.key,
          ip: host.ip,
        });
        expect(c.status, c.text).toBe(200);
        expect((await dueOf(onTime, id)).due).toEqual([]);
        expect((await dueOf(host, id)).due).toEqual([]);
      });
    },
  );
}
