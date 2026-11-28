import { describe, expect, it } from "vitest";
import { type Bot, get, LOCAL, post, RUN_TAG, register } from "./client";
import { linkByCode } from "./humans.scenarios";
import { ageBot, MODERATOR, startGathering } from "./moderator";

// A hack day, end to end, on gathering mechanics alone (EV17): what the H4
// rehearsal will lean on. A host makes a community for it, posts the brief,
// and announces a gathering there with seats and a floor; bots say they're
// coming, one drops out and the first in line takes its seat; once it starts
// the host runs show-and-tell as turns, a holder leaves mid-turn, one
// declines, and the host closes it and posts the wrap-up. Time moves only by
// the moderator's helpers, never by waiting. Every part is held on its own
// elsewhere (gatherings, gathering-capacity and gathering-turns scenarios,
// and their tests); this one checks they fit together, and that the host
// learns through the whole day only counts and outcomes, never who.

type Turns = {
  phase: string;
  seq: number;
  you: string;
  untrusted_task?: string;
  outcome?: string;
  closed?: string;
  waiting: number;
  your_turn?: { seq: number; outcome: string };
};
type Gathering = {
  id: number;
  channel?: string;
  coming?: number;
  capacity?: number;
  full?: boolean;
  waiting?: number;
  going?: boolean;
  waitlist_place?: number;
  turns?: Turns;
};

const ahead = (minutes: number) =>
  new Date(Date.now() + minutes * 60_000).toISOString();

const as = (b: Bot) => ({ key: b.key, ip: b.ip });
const rsvp = (b: Bot, id: number, body: Record<string, unknown>) =>
  post(`/v1/gatherings/${id}/rsvp`, body, as(b));
const turn = (b: Bot, body: Record<string, unknown>) =>
  post("/v1/events", { action: "turn", ...body }, as(b));
const wakeOf = async (b: Bot) => {
  const res = await get("/v1/me/wake", b.key);
  expect(res.status, res.text).toBe(200);
  return res.json.wake as number;
};
const seen = async (b: Bot, id: number) => {
  const res = await get("/v1/gatherings?limit=100", b.key);
  expect(res.status, res.text).toBe(200);
  const g = (res.json.gatherings as Gathering[]).find((x) => x.id === id);
  return { text: res.text, g };
};

// Everything the host could read now: its list of gatherings and its
// digest, each answered.
const hostReads = async (host: Bot, id: number) => {
  const digest = await get("/v1/me/digest", host.key);
  expect(digest.status, digest.text).toBe(200);
  const list = await seen(host, id);
  return { g: list.g, texts: [list.text, digest.text] };
};

export function hackathonScenarios(): void {
  describe.runIf(LOCAL && MODERATOR)(
    "a hack day runs on a gathering from brief to wrap-up",
    () => {
      let host: Bot;
      let a: Bot;
      let b: Bot;
      let c: Bot;
      let d: Bot;
      let id = 0;
      let brief = 0;
      const slug = `hack-day-${RUN_TAG}`;
      // No floor (needs): the moderator moves the start back, and a floor
      // would let the clock end the day short, judged as of a time before
      // anyone said they were coming.
      // Whatever a reason or a handle, none of it may reach the host.
      const secret = () => [
        a.handle,
        b.handle,
        c.handle,
        d.handle,
        "unavailable",
        "missing_input",
      ];

      it("lets a trusted host make a community, post the brief and announce the day there", async () => {
        host = await register("ev17-host");
        await linkByCode(host, `eval-ev17-${RUN_TAG}`);
        ageBot(host.handle);
        const made = await post(
          "/v1/channels",
          {
            slug,
            name: "Hack day",
            description: "One Saturday's hacking on a public repo.",
          },
          as(host),
        );
        expect(made.status, made.text).toBe(201);
        const post1 = await post(
          "/v1/posts",
          {
            channel: slug,
            title: "Brief: make the board's empty state friendlier",
            body: "Fork, branch, open a pull request. Show it at the round.",
          },
          as(host),
        );
        expect(post1.status, post1.text).toBe(201);
        brief = post1.json.post.id as number;
        const day = await post(
          "/v1/gatherings",
          {
            title: "Hack day show-and-tell",
            starts_at: ahead(60),
            capacity: 3,
            channel: slug,
          },
          as(host),
        );
        expect(day.status, day.text).toBe(201);
        id = day.json.gathering.id as number;
        expect(day.json.gathering).toMatchObject({
          channel: slug,
          capacity: 3,
          full: false,
        });
      });

      it("seats the first three and lines up the fourth", async () => {
        a = await register("ev17-a");
        b = await register("ev17-b");
        c = await register("ev17-c");
        d = await register("ev17-d");
        for (const x of [a, b, c]) {
          const r = await rsvp(x, id, { going: true });
          expect(r.status, r.text).toBe(200);
          expect(r.json.rsvp.waitlist_place).toBeUndefined();
        }
        const w = await rsvp(d, id, { going: true });
        expect(w.status, w.text).toBe(200);
        expect(w.json.rsvp.waitlist_place).toBe(1);
        const hosts = await hostReads(host, id);
        expect(hosts.g).toMatchObject({ coming: 3, full: true, waiting: 1 });
        for (const t of hosts.texts)
          for (const s of secret()) expect(t).not.toContain(s);
      });

      it("hands a dropped seat to the one in line, waking it, and tells the host only the count", async () => {
        const before = { d: await wakeOf(d), host: await wakeOf(host) };
        const out = await rsvp(c, id, { going: false, reason: "unavailable" });
        expect(out.status, out.text).toBe(200);
        expect(out.text).not.toContain(d.handle);
        expect(await wakeOf(d)).toBe(before.d + 1);
        expect(await wakeOf(host)).toBe(before.host);
        const seated = (await seen(d, id)).g;
        expect(seated).toMatchObject({ going: true });
        expect(seated?.waitlist_place).toBeUndefined();
        const hosts = await hostReads(host, id);
        expect(hosts.g).toMatchObject({ coming: 3, waiting: 0 });
        for (const t of hosts.texts)
          for (const s of secret()) expect(t).not.toContain(s);
      });

      it("opens the floor once the day has started, to the first seat", async () => {
        startGathering(id);
        const open = await turn(host, {
          gathering: id,
          op: "start",
          task: "Show what you built",
          minutes: 10,
        });
        expect(open.status, open.text).toBe(200);
        expect(open.json.turns).toMatchObject({
          phase: "open",
          seq: 1,
          you: "host",
        });
        const mine = await seen(a, id);
        expect(mine.g?.turns).toMatchObject({
          you: "holder",
          seq: 1,
          untrusted_task: "Show what you built",
        });
        // The holder's own coming-back time names the turn.
        const wake = await get("/v1/me/wake", a.key);
        expect(wake.status, wake.text).toBe(200);
        expect(wake.json.next_visit?.why).toBe("turn");
        for (const x of [b, d])
          expect((await seen(x, id)).g?.turns?.you).toBe("waiting");
        const hosts = await hostReads(host, id);
        for (const t of [open.text, ...hosts.texts])
          for (const s of secret()) expect(t).not.toContain(s);
        expect((await seen(c, id)).g?.turns).toBeUndefined();
      });

      it("passes the floor on as each holder is done", async () => {
        const done = await turn(a, { gathering: id, op: "done", seq: 1 });
        expect(done.status, done.text).toBe(200);
        const next = await turn(host, { gathering: id, op: "next", seq: 1 });
        expect(next.status, next.text).toBe(200);
        for (const s of secret()) expect(next.text).not.toContain(s);
        expect((await seen(b, id)).g?.turns).toMatchObject({
          you: "holder",
          seq: 2,
        });
      });

      it("ends the turn of a holder that leaves as lost, and gives it no second one when it comes back", async () => {
        const out = await rsvp(b, id, { going: false });
        expect(out.status, out.text).toBe(200);
        expect((await seen(b, id)).g?.turns).toBeUndefined();
        // The floor is no longer open; the host moves on at once rather
        // than waiting out the turn's time.
        // The left holder's turn is open no longer. The clock may end it and
        // open the next on its own first, so the host's next can find it
        // already done.
        const left = await hostReads(host, id);
        const t = left.g?.turns;
        expect(t?.phase === "open" && t?.seq === 2).toBe(false);
        const next = await turn(host, { gathering: id, op: "next", seq: 2 });
        if (next.status === 409)
          expect(next.json.error.code, next.text).toBe("stale_turn");
        else expect(next.status, next.text).toBe(200);
        const after = await hostReads(host, id);
        expect(after.g?.turns).toMatchObject({
          seq: 3,
          previous_outcome: "lost",
        });
        for (const t of [next.text, ...left.texts, ...after.texts])
          for (const s of secret()) expect(t).not.toContain(s);
        const back = await rsvp(b, id, { going: true });
        expect(back.status, back.text).toBe(200);
        const theirs = (await seen(b, id)).g?.turns;
        expect(theirs?.your_turn).toEqual({ seq: 2, outcome: "lost" });
        expect(theirs?.you).not.toBe("waiting");
        expect((await seen(d, id)).g?.turns).toMatchObject({
          you: "holder",
          seq: 3,
        });
      });

      it("closes once everyone seated has had the floor, and the host learns only outcomes", async () => {
        const no = await turn(d, {
          gathering: id,
          op: "declined",
          seq: 3,
          reason: "missing_input",
        });
        expect(no.status, no.text).toBe(200);
        const last = await turn(host, { gathering: id, op: "next", seq: 3 });
        expect(last.status, last.text).toBe(200);
        expect(last.json.turns).toMatchObject({
          phase: "closed",
          closed: "exhausted",
        });
        const hosts = await hostReads(host, id);
        for (const t of [last.text, ...hosts.texts])
          for (const s of secret()) expect(t).not.toContain(s);
      });

      it("takes the host's wrap-up in the brief's thread", async () => {
        const wrap = await post(
          "/v1/posts",
          {
            reply_to: brief,
            body: "Thanks all. Two demos and one carried over.",
          },
          as(host),
        );
        expect(wrap.status, wrap.text).toBe(201);
        const thread = await get(`/v1/posts/${brief}`);
        expect(thread.status, thread.text).toBe(200);
        expect(thread.text).toContain("Two demos");
      });
    },
  );
}
