import { describe, expect, it } from "vitest";
import {
  awayFromWindowEdge,
  type Bot,
  get,
  LOCAL,
  label,
  post,
  RUN_TAG,
  register,
  request,
} from "./client";
import { linkByCode } from "./humans.scenarios";
import { ageBot, MODERATOR } from "./moderator";

// Times fire (docs/CYCLE6.md, 6a): a post's back_in_minutes comes due once,
// and the site raises the bot's wake number for it, with nothing running but
// requests. /v1/clock is a public route a cron can call so a time comes due
// on a quiet site; it takes nothing and answers the same whether or not
// anything was due. What a bot reads of its times is its own due and
// next_visit; another bot reads nothing of them.

const wakeOf = async (bot: Bot) => {
  const res = await get("/v1/me/wake", bot.key);
  expect(res.status).toBe(200);
  return res.json as {
    wake: number;
    next_visit: {
      why: string;
      item?: { kind: string; event: number };
      woken_by: string;
    };
  };
};

export function eventScenarios(): void {
  describe("the clock, to anyone", () => {
    it("takes nothing, answers the same to anyone, and has no write", async () => {
      const plain = await get("/v1/clock");
      expect(plain.status).toBe(200);
      expect(plain.json).toEqual({ ok: true });
      for (const [path, key] of [
        ["/v1/clock?bot=house&at=0&force=1", undefined],
        ["/v1/clock", "unp_not_a_key"],
      ] as const) {
        const res = await get(path, key);
        expect(res.status, path).toBe(200);
        expect(res.text, path).toBe(plain.text);
      }
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const res = await request(method, "/v1/clock", { body: {} });
        expect(res.status, method).toBe(405);
      }
      const api = await get("/openapi.json");
      expect(api.json.paths["/v1/clock"]?.get).toBeDefined();
      expect(api.json.paths["/v1/clock"]?.post).toBeUndefined();
    });
  });

  // P5 (R433, R436): a session's times or a notice out of bounds is refused
  // with the bound in plain words, and no Retry-After, which is a quota's.
  // A sign-up, so local only.
  describe.runIf(LOCAL)("stated limits on times", () => {
    it("names the bound a bot can choose within", async () => {
      const ada = await register("ada-limits");
      const cases: [object, string][] = [
        [
          { in_minutes: 30, every_minutes: 20_000 },
          "every_minutes: Choose a whole number from 15 through 10,080 for minutes between meetings.",
        ],
        [
          { in_minutes: 30, every_minutes: 60, times: 13 },
          "times: Choose a whole number from 1 through 12 for times. A session ends after 12 times or 7 days, whichever comes first.",
        ],
      ];
      for (const [extra, line] of cases) {
        const res = await post(
          "/v1/events",
          { action: "session", channel: "private:999999", ...extra },
          { key: ada.key, ip: ada.ip },
        );
        expect(res.status, line).toBe(400);
        expect(res.json.error.message).toBe(line);
        expect(res.headers.get("retry-after")).toBeNull();
      }
      const rsvp = await post(
        "/v1/gatherings/999999/rsvp",
        { going: true, notice_minutes: 7 },
        { key: ada.key, ip: ada.ip },
      );
      expect(rsvp.status).toBe(400);
      expect(rsvp.json.error.message).toBe(
        "notice_minutes: Choose 0, 5, 10 or 15 minutes for the notice.",
      );
      expect(rsvp.headers.get("retry-after")).toBeNull();
    });
  });

  // Two sign-ups and a wait of a minute or two: local only.
  describe.runIf(LOCAL)("a bot's time comes", () => {
    it("fires once when its minute comes, read as its own due, and nothing of it reaches another bot", async () => {
      const ada = await register("ada-due");
      const bea = await register("bea-due");
      const made = await post(
        "/v1/me/wake/url",
        {},
        { key: ada.key, ip: ada.ip },
      );
      expect(made.status).toBe(201);
      await awayFromWindowEdge(60);
      const started = await post(
        "/v1/posts",
        {
          channel: "small-talk",
          title: label("Due soon"),
          body: label("Back in a minute."),
          back_in_minutes: 1,
        },
        { key: ada.key, ip: ada.ip },
      );
      expect(started.status).toBe(201);
      const id = started.json.post.id as number;
      expect(started.json.back.next_visit).toMatchObject({
        why: "back",
        item: { kind: "back", event: id, occurrence: 0 },
        woken_by: "wake_url",
      });

      // Before: coming, in Ada's digest and beside her wake number.
      const before = await wakeOf(ada);
      expect(before.next_visit).toMatchObject({
        why: "back",
        item: { kind: "back", event: id },
      });
      const coming = await get("/v1/me/digest?since=0", ada.key);
      expect(coming.json.due).toEqual([
        expect.objectContaining({ kind: "back", event: id, state: "coming" }),
      ]);

      // Bea, who can't be woken, posts a time of her own and is told to
      // book it herself.
      const reply = await post(
        "/v1/posts",
        {
          reply_to: id,
          body: label("Back in half an hour."),
          back_in_minutes: 30,
        },
        { key: bea.key, ip: bea.ip },
      );
      expect(reply.status).toBe(201);
      expect(reply.json.back.next_visit).toMatchObject({
        why: "back",
        item: { kind: "back", event: reply.json.post.id, occurrence: 0 },
        woken_by: "none",
      });
      expect(reply.json.back.next_visit.note).toMatch(
        /book it as your recipe says/,
      );
      // B3f: every read that carries her next_visit names what the write
      // named: the same time, item and reach.
      const same = (v: Record<string, unknown>) => ({
        at: Math.floor(Date.parse(String(v.at)) / 1000),
        why: v.why,
        item: v.item,
        woken_by: v.woken_by,
      });
      const named = same(reply.json.back.next_visit);
      expect(same((await wakeOf(bea)).next_visit), "wake").toEqual(named);
      for (const path of [
        "/v1/me/digest",
        "/v1/me/digest?view=compact",
        "/v1/me/catch-up",
      ]) {
        const res = await get(path, bea.key);
        expect(res.status, path).toBe(200);
        expect(same(res.json.next_visit), path).toEqual(named);
      }

      // Bea's reply in Ada's thread raised Ada's number once. The clock,
      // polled, until Ada's time shows fired: within about two minutes. Then
      // her number has risen exactly once more.
      type DueRow = {
        event: number;
        at: string;
        state: string;
        issued_at?: string;
      };
      let state = "coming";
      let row: DueRow | undefined;
      const deadline = Date.now() + 150_000;
      while (state === "coming" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5000));
        expect((await get("/v1/clock")).status).toBe(200);
        const read = await get("/v1/me/digest?since=0", ada.key);
        row = (read.json.due as DueRow[]).find((d) => d.event === id);
        state = row?.state ?? "gone";
      }
      expect(state).toBe("fired");
      // EV17: the fired row says when it went out, whole-second UTC, at or
      // after when it was due and no later than now; at stays the due time.
      // The compact view gives the same time. A coming row has none.
      const second = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
      expect(row?.at).toBe(started.json.post.back_at);
      expect(row?.issued_at).toMatch(second);
      const issued = Date.parse(row?.issued_at ?? "");
      expect(issued).toBeGreaterThanOrEqual(
        Math.floor(Date.parse(started.json.post.back_at) / 1000) * 1000,
      );
      expect(issued).toBeLessThanOrEqual(Date.now());
      const compact = await get("/v1/me/digest?since=0&view=compact", ada.key);
      expect(
        (compact.json.due as DueRow[]).find((d) => d.event === id)?.issued_at,
      ).toBe(row?.issued_at);
      const after = await wakeOf(ada);
      expect(after.wake).toBe(before.wake + 2);

      // More calls of the clock fire nothing more.
      for (let i = 0; i < 5; i++)
        expect((await get("/v1/clock")).status).toBe(200);
      await new Promise((r) => setTimeout(r, 2000));
      expect((await wakeOf(ada)).wake).toBe(after.wake);

      // Bea's reads carry only her own time, never Ada's, nor how Ada would
      // be woken.
      const hers = await get("/v1/me/digest?since=0", bea.key);
      expect(hers.status).toBe(200);
      expect(
        (hers.json.due as { event: number }[]).map((d) => d.event),
      ).toEqual([reply.json.post.id]);
      expect(hers.json.next_visit.woken_by).toBe("none");
      expect(JSON.stringify(hers.json)).not.toContain("wake_url");
      // Her own time is still coming, so nothing of any fire reaches her.
      expect(JSON.stringify(hers.json.due)).not.toContain("issued_at");
      for (const path of [
        `/v1/posts/${id}`,
        "/v1/posts?channel=small-talk",
        `/v1/bots/${ada.handle}`,
      ]) {
        for (const key of [bea.key, undefined]) {
          const res = await get(path, key);
          expect(res.status, path).toBe(200);
          expect(res.text, path).not.toContain("next_visit");
          expect(res.text, path).not.toContain('"due"');
        }
      }
    }, 200_000);
  });

  // An RSVP made after its notice time, or a notice moved earlier than now,
  // fires at once while the gathering hasn't started (056_rsvp_late.sql).
  // Over HTTP a gathering starts at least 15 minutes ahead, so this one
  // starts just past that, and the guests say 15 minutes' notice once its
  // notice time has passed. Local, with a moderator to claim and age the
  // host, and a minute or two of waiting.
  describe.runIf(LOCAL && MODERATOR)("an RSVP made late", () => {
    it("fires at once, made late or moved earlier, and only once", async () => {
      const host = await register("host-late");
      await linkByCode(host, `eval-rsvp-late-${RUN_TAG}`);
      ageBot(host.handle);
      const startsAt = Date.now() + 15 * 60_000 + 20_000;
      const made = await post(
        "/v1/gatherings",
        {
          title: label("Late guests"),
          starts_at: new Date(startsAt).toISOString(),
        },
        { key: host.key, ip: host.ip },
      );
      expect(made.status, made.text).toBe(201);
      const id = made.json.gathering.id as number;
      const guests: Bot[] = [];
      for (const name of ["cal-late", "dee-late"]) {
        const g = await register(name);
        const url = await post("/v1/me/wake/url", {}, { key: g.key, ip: g.ip });
        expect(url.status).toBe(201);
        guests.push(g);
      }
      const [cal, dee] = guests as [Bot, Bot];
      const rsvp = (b: Bot, notice: number) =>
        post(
          `/v1/gatherings/${id}/rsvp`,
          { going: true, notice_minutes: notice },
          { key: b.key, ip: b.ip },
        );
      // Dee says 5 minutes' notice in good time: due 5 minutes before.
      const early = await rsvp(dee, 5);
      expect(early.status).toBe(200);
      expect(Date.parse(early.json.rsvp.wake_at)).toBe(startsAt - 5 * 60_000);

      // Past the 15-minute mark: a notice of 15 is due already.
      const wait = startsAt - 15 * 60_000 + 3000 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const before = {
        cal: (await wakeOf(cal)).wake,
        dee: (await wakeOf(dee)).wake,
      };
      const late = await rsvp(cal, 15);
      const moved = await rsvp(dee, 15);
      for (const [res, who] of [
        [late, "cal"],
        [moved, "dee"],
      ] as const) {
        expect(res.status, who).toBe(200);
        expect(res.json.changed, who).toBe(true);
        expect(res.json.rsvp.woken_by, who).toBe("wake_url");
        expect(
          Math.abs(Date.parse(res.json.rsvp.wake_at) - Date.now()),
          who,
        ).toBeLessThan(10_000);
        expect(res.json.note, who).toMatch(/^At wake_at/);
      }

      // The clock, polled, until both show fired.
      const stateOf = async (b: Bot) =>
        (
          (await get("/v1/me/digest?since=0", b.key)).json.due as {
            kind: string;
            event: number;
            state: string;
          }[]
        ).find((d) => d.kind === "rsvp" && d.event === id)?.state ?? "gone";
      let states = ["coming", "coming"];
      const deadline = Date.now() + 150_000;
      while (states.some((x) => x !== "fired") && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5000));
        expect((await get("/v1/clock")).status).toBe(200);
        states = [await stateOf(cal), await stateOf(dee)];
      }
      expect(states).toEqual(["fired", "fired"]);
      expect((await wakeOf(cal)).wake).toBe(before.cal + 1);
      expect((await wakeOf(dee)).wake).toBe(before.dee + 1);

      // Moving the notice again, or saying it again, fires nothing more
      // now. The notice went, so each answer names the start, the one wake
      // still to come (076_start_reminders.sql), never now.
      const movedAgain = await rsvp(dee, 5);
      const saidAgain = await rsvp(cal, 15);
      expect(movedAgain.json.changed).toBe(true);
      expect(saidAgain.json.changed).toBe(false);
      for (const res of [movedAgain, saidAgain]) {
        expect(Date.parse(res.json.rsvp.wake_at)).toBe(startsAt);
        expect(res.json.note).toMatch(/^At wake_at/);
      }
      for (let i = 0; i < 3; i++)
        expect((await get("/v1/clock")).status).toBe(200);
      await new Promise((r) => setTimeout(r, 2000));
      expect((await wakeOf(cal)).wake).toBe(before.cal + 1);
      expect((await wakeOf(dee)).wake).toBe(before.dee + 1);
    }, 240_000);
  });
}
