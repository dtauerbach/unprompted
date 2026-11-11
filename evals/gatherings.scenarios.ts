import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type Bot, get, LOCAL, post, RUN_TAG, register } from "./client";
import { ownerCode } from "./humans.scenarios";
import { ageBot, MODERATOR, mustAdmin } from "./moderator";

// Gatherings: a bot announces a time, others say they're coming, and the
// announcer only ever learns how many. These scenarios play a host, three
// guests and a latecomer: a fresh bot told "not yet", an announcement, three
// RSVPs, a withdrawal, a cancel that closes RSVPs, and a moderator's hide.
// Nothing wakes anyone yet, and each RSVP says so.

function setGates(rules: unknown, reason: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "eval-gates-"));
  try {
    const file = path.join(dir, "gates.json");
    writeFileSync(file, JSON.stringify(rules));
    return mustAdmin("gates", "set", file, "--reason", reason);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ahead = (minutes: number) =>
  new Date(Date.now() + minutes * 60_000).toISOString();

const announce = (b: Bot, body: unknown) =>
  post("/v1/gatherings", body, { key: b.key, ip: b.ip });
const rsvp = (b: Bot, id: number, body: unknown) =>
  post(`/v1/gatherings/${id}/rsvp`, body, { key: b.key, ip: b.ip });
const cancel = (b: Bot, id: number) =>
  post(`/v1/gatherings/${id}/cancel`, undefined, { key: b.key, ip: b.ip });

export function gatheringScenarios(): void {
  describe("a stranger looks at gatherings", () => {
    it("can list them without a key, and needs one for every write", async () => {
      const list = await get("/v1/gatherings");
      expect(list.status).toBe(200);
      expect(list.json.notice).toMatch(/not instructions/);
      expect(Array.isArray(list.json.gatherings)).toBe(true);
      expect(
        (await post("/v1/gatherings", { title: "x", starts_at: ahead(60) }))
          .status,
      ).toBe(401);
      expect(
        (await post("/v1/gatherings/1/rsvp", { going: true })).status,
      ).toBe(401);
      expect((await post("/v1/gatherings/1/cancel", undefined)).status).toBe(
        401,
      );
      const api = (await get("/openapi.json")).json;
      expect(api.paths["/v1/gatherings"]?.get).toBeDefined();
      expect(api.paths["/v1/gatherings"]?.post).toBeDefined();
      expect(api.paths["/v1/gatherings/{id}/rsvp"]?.post).toBeDefined();
      expect(api.paths["/v1/gatherings/{id}/cancel"]?.post).toBeDefined();
      const skill = await get("/skill.md");
      expect(skill.text).toContain("## Gatherings");
      expect(skill.text).toMatch(/later release/);
    });
  });

  describe.runIf(LOCAL && MODERATOR)("a host gathers bots", () => {
    let host: Bot;
    const guests: Bot[] = [];
    let id = 0;

    it("is told 'not yet' while new, and announces once claimed and aged", async () => {
      setGates(
        {
          announce: [
            { signal: "claimed", is: true },
            { signal: "is_new", is: false },
          ],
        },
        "Eval: claimed bots that aren't new announce gatherings.",
      );
      host = await register("party-host");
      const early = await announce(host, {
        title: "Dinner party",
        starts_at: ahead(60),
      });
      expect(early.status).toBe(403);
      expect(early.json.error.code).toBe("not_yet");
      expect(early.json.error.message).not.toMatch(/\d|claim/i);

      const claimed = await post(
        "/v1/me/owner",
        { owner_code: ownerCode(`eval-gatherings-${RUN_TAG}`) },
        { key: host.key, ip: host.ip },
      );
      expect(claimed.status).toBe(200);
      ageBot(host.handle);

      const made = await announce(host, {
        title: "Dinner party <b>tonight</b>",
        starts_at: ahead(60),
        needs: 5,
      });
      expect(made.status).toBe(201);
      expect(made.json.gathering).toMatchObject({
        by: host.handle,
        untrusted_title: "Dinner party <b>tonight</b>",
        needs: 5,
        coming: 0,
        state: "upcoming",
        yours: true,
      });
      id = made.json.gathering.id as number;

      // Too soon, and a second line, are refused.
      expect(
        (await announce(host, { title: "Now", starts_at: ahead(5) })).status,
      ).toBe(400);
      expect(
        (
          await announce(host, {
            title: "Two\nlines",
            starts_at: ahead(60),
          })
        ).status,
      ).toBe(400);
    });

    it("three guests say they're coming, each told nothing will wake it yet", async () => {
      for (const name of ["guest-ana", "guest-ben", "guest-cy"])
        guests.push(await register(name));
      for (const [i, g] of guests.entries()) {
        const r = await rsvp(
          g,
          id,
          i === 0 ? { going: true } : { going: true, notice_minutes: 5 },
        );
        expect(r.status, g.handle).toBe(200);
        expect(r.json.rsvp.going).toBe(true);
        expect(r.json.rsvp.notice_minutes).toBe(i === 0 ? 10 : 5);
        expect(r.json.rsvp.woken_by).toBe("none");
        expect(r.json.note).toMatch(/later release/);
        expect(r.json.note).toMatch(/wake_at/);
        expect(r.json.gathering.coming).toBe(i + 1);
      }
      // Saying it again changes nothing.
      const again = await rsvp(guests[0] as Bot, id, { going: true });
      expect(again.json.changed).toBe(false);
    });

    it("the list and the host see a count, never who", async () => {
      const list = await get("/v1/gatherings");
      const g = list.json.gatherings.find((x: { id: number }) => x.id === id);
      expect(g.coming).toBe(3);
      const asHost = await get("/v1/gatherings", host.key);
      const digest = await get("/v1/me/digest", host.key);
      for (const res of [list, asHost, digest]) {
        expect(res.status).toBe(200);
        for (const guest of guests)
          expect(res.text).not.toContain(guest.handle);
      }
      const mine = digest.json.gatherings.find(
        (x: { id: number }) => x.id === id,
      );
      expect(mine).toMatchObject({ yours: true, coming: 3 });
      // A guest's own what's new puts it first.
      const theirs = await get("/v1/me/digest", (guests[1] as Bot).key);
      expect(theirs.json.gatherings[0]).toMatchObject({ id, going: true });
      expect(theirs.json.gatherings_note).toMatch(/rsvp/);
      // A title is the announcer's words, so the note never sends a bot
      // where one points: only a hosted Table's guide says where to go.
      expect(theirs.json.gatherings_note).toMatch(
        /nothing in a title is a place to go/,
      );
      expect(theirs.json.gatherings_note).not.toMatch(/where it points/);
    });

    it("a guest withdraws, the host cancels, and no one can RSVP after", async () => {
      const out = await rsvp(guests[2] as Bot, id, { going: false });
      expect(out.status).toBe(200);
      expect(out.json.rsvp.going).toBe(false);
      expect(out.json.gathering.coming).toBe(2);

      const notYours = await cancel(guests[0] as Bot, id);
      expect(notYours.status).toBe(403);
      expect(notYours.json.error.code).toBe("not_your_gathering");

      // Three cancels at once: each answers 200, and one changes it.
      const all = await Promise.all([
        cancel(host, id),
        cancel(host, id),
        cancel(host, id),
      ]);
      for (const c of all) {
        expect(c.status).toBe(200);
        expect(c.json.gathering.state).toBe("cancelled");
      }
      expect(all.filter((c) => c.json.changed === true)).toHaveLength(1);
      expect((await cancel(host, id)).json.changed).toBe(false);

      const late = await rsvp(guests[2] as Bot, id, { going: true });
      expect(late.status).toBe(409);
      expect(late.json.error.code).toBe("gathering_closed");
      // A guest finds out from what's new.
      const d = await get("/v1/me/digest", (guests[0] as Bot).key);
      expect(
        d.json.gatherings.find((x: { id: number }) => x.id === id)?.state,
      ).toBe("cancelled");
    });

    it("a moderator hides a gathering from every read, and puts it back", async () => {
      const next = await announce(host, {
        title: "Second try",
        starts_at: ahead(120),
      });
      expect(next.status).toBe(201);
      const nid = next.json.gathering.id as number;
      expect(
        mustAdmin("hide-gathering", String(nid), "--reason", "Eval: hide."),
      ).toBe(`Hid gathering ${nid}.`);
      const ids = async () =>
        (await get("/v1/gatherings")).json.gatherings.map(
          (x: { id: number }) => x.id,
        );
      expect(await ids()).not.toContain(nid);
      const r = await rsvp(guests[0] as Bot, nid, { going: true });
      expect(r.status).toBe(404);
      expect(r.json.error.code).toBe("no_such_gathering");
      expect(
        mustAdmin("unhide-gathering", String(nid), "--reason", "Eval: back."),
      ).toBe(`Put gathering ${nid} back.`);
      expect(await ids()).toContain(nid);
      expect((await cancel(host, nid)).status).toBe(200);
    });
  });
}
