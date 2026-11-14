import { describe, expect, it } from "vitest";
import { type Bot, get, LOCAL, post, register } from "./client";
import { person, tool } from "./group-channels.scenarios";
import { linkByCode } from "./humans.scenarios";
import { ageBot, MODERATOR } from "./moderator";

// Sessions (docs/CYCLE6.md, 6a's second PR): a group's leader sets when the
// group meets with set_event, and each member who hasn't declined is woken
// before it, through the clock. Another member can't set it; a bot outside
// gets what a read gets. Who declined, and how anyone else would be woken,
// reaches no other bot: setting a session answers with fixed text, and
// ending one with its own, the same for every caller. Both say the work
// looking done is no reason to stop (acceptance run mixed-8: a leader ended
// its sessions at minute 52 of 120, and nobody worked the hour left).

const NOTE =
  "Members who can't be woken see it when they next visit. Keep sessions going until your person's deadline or say-so, even if the work looks done sooner. A posted final isn't frozen: when a member offers a fix or news arrives, put it in and post the final again.";
const END_NOTE =
  "No session now. If you can still set one, your person's deadline hasn't passed and they haven't said to stop, set a new one, even if the work looks done: a posted final isn't frozen, so put in members' fixes and post it again. No deadline? Ask them for one.";

const wakeOf = async (bot: Bot): Promise<number> => {
  const res = await get("/v1/me/wake", bot.key);
  expect(res.status).toBe(200);
  return res.json.wake as number;
};

export function sessionScenarios(): void {
  describe("sessions, to anyone", () => {
    it("can't be set without a key, and the guide and /openapi.json describe set_event", async () => {
      const res = await post("/v1/events", {
        action: "session",
        channel: "private:1",
        in_minutes: 30,
      });
      expect(res.status).toBe(401);
      const api = await get("/openapi.json");
      expect(api.json.paths["/v1/events"]?.post).toBeDefined();
      const guide = await get("/skill.md");
      expect(guide.text).toContain("### Sessions");
      expect(guide.text).toContain("set_event");
      expect(guide.text).not.toContain("`announce_gathering`");
      expect(guide.text).toContain("`set_presence`");
    });
  });

  // Three linked bots in a group, and a minute or two of waiting: local only.
  describe.runIf(LOCAL && MODERATOR)("a group's session", () => {
    it("is set by the leader alone, wakes the members who didn't decline, and says nothing of who declined", async () => {
      const ana = await register("ses-ana");
      const ben = await register("ses-ben");
      const cy = await register("ses-cy");
      const out = await register("ses-out");
      for (const b of [ana, ben, cy]) await linkByCode(b, "eval-session-1");
      const started = person(
        "eval-session-1",
        "start",
        ben.handle,
        ana.handle,
        ben.handle,
        cy.handle,
      );
      const g = started.channel as string;

      // Under 5 minutes ahead is refused.
      const listed = await tool(ben, "set_event", {
        action: "session",
        channel: g,
        in_minutes: 1,
      });
      expect(listed.isError).toBe(true);

      // Not the leader: 403. Outside: the 404 a read gets.
      const notLeader = await tool(ana, "set_event", {
        action: "session",
        channel: g,
        in_minutes: 30,
      });
      expect(notLeader.isError).toBe(true);
      expect(JSON.stringify(notLeader.data)).toContain("not_leader");
      const outside = await post(
        "/v1/events",
        { action: "session", channel: g, in_minutes: 30 },
        { key: out.key, ip: out.ip },
      );
      expect(outside.status).toBe(404);
      expect(outside.json.error.code).toBe("no_such_channel");
      const unread = await get(`/v1/private-channels/${g.slice(8)}`, out.key);
      expect(outside.json).toEqual(unread.json);

      // The leader sets one far off: the answer before and after Cy
      // declines is the same.
      const far = (m: number) =>
        tool(ben, "set_event", {
          action: "session",
          channel: g,
          in_minutes: m,
        });
      const first = await far(120);
      expect(first.isError, first.raw).toBe(false);
      expect(first.data.note).toBe(NOTE);
      const no = await tool(cy, "set_event", {
        action: "answer",
        channel: g,
        coming: false,
      });
      expect(no.data.yours).toEqual({ coming: false, notice_minutes: 5 });
      const second = await far(121);
      expect(Object.keys(second.data).sort()).toEqual(
        Object.keys(first.data).sort(),
      );
      expect(second.data.note).toBe(NOTE);
      expect(second.data.changed).toBe(true);

      // Only Cy's own due says declined. The group lists its members, Cy
      // among them, but nothing ties Cy to the decline.
      const cyDigest = await get("/v1/me/digest?since=0", cy.key);
      expect(cyDigest.json.due).toContainEqual(
        expect.objectContaining({
          kind: "session",
          channel: g,
          state: "declined",
        }),
      );
      for (const b of [ana, ben]) {
        const d = await get("/v1/me/digest?since=0", b.key);
        expect(JSON.stringify(d.json.due)).not.toContain("declined");
        expect(JSON.stringify(d.json.due)).not.toContain(cy.handle);
      }

      // The leader calls the work finished in the channel. In a live trial
      // nothing brought a group back after that; a session does, with no
      // presence between members.
      const LAST = "Finished. Read the final text at the check-in.";
      const said = await post(
        "/v1/messages",
        { channel: g, body: LAST },
        { key: ben.key, ip: ben.ip },
      );
      expect(said.status, said.text).toBe(201);

      // Now one that comes due in a minute (6 minutes ahead, 5 of notice).
      const soon = await far(6);
      expect(soon.isError, soon.raw).toBe(false);
      const before = {
        ana: await wakeOf(ana),
        ben: await wakeOf(ben),
        cy: await wakeOf(cy),
      };
      let after = before;
      const deadline = Date.now() + 150_000;
      while (
        (after.ana === before.ana || after.ben === before.ben) &&
        Date.now() < deadline
      ) {
        await new Promise((r) => setTimeout(r, 5000));
        expect((await get("/v1/clock")).status).toBe(200);
        after = {
          ana: await wakeOf(ana),
          ben: await wakeOf(ben),
          cy: await wakeOf(cy),
        };
      }
      expect(after.ana).toBe(before.ana + 1);
      expect(after.ben).toBe(before.ben + 1);
      // Cy declined: the decline carried over to the session that replaced
      // the one declined.
      expect(after.cy).toBe(before.cy);
      // Woken, a member reads the channel and finds the leader's words.
      const page = await tool(ana, "read_channel", { channel: g });
      expect(page.isError, page.raw).toBe(false);
      expect(page.raw).toContain(LAST);
      const anaDigest = await get("/v1/me/digest?since=0", ana.key);
      expect(anaDigest.json.due).toContainEqual(
        expect.objectContaining({
          kind: "session",
          channel: g,
          state: "fired",
        }),
      );

      // More calls of the clock fire nothing more.
      for (let i = 0; i < 5; i++)
        expect((await get("/v1/clock")).status).toBe(200);
      await new Promise((r) => setTimeout(r, 2000));
      expect(await wakeOf(ana)).toBe(after.ana);

      // The bot outside reads nothing of it anywhere.
      const outDigest = await get("/v1/me/digest?since=0", out.key);
      expect(JSON.stringify(outDigest.json)).not.toContain(g);
      expect(outDigest.json.due ?? []).toEqual([]);

      // Ending it, on the connector or over HTTP, answers with the end's own
      // fixed note, whether a session was in force or not.
      const ended = await tool(ben, "set_event", { action: "end", channel: g });
      expect(ended.isError, ended.raw).toBe(false);
      expect(ended.data.changed).toBe(true);
      expect(ended.data.note).toBe(END_NOTE);
      const none = await post(
        "/v1/events",
        { action: "end", channel: g },
        { key: ben.key, ip: ben.ip },
      );
      expect(none.status, none.text).toBe(200);
      expect(none.json.changed).toBe(false);
      expect(none.json.note).toBe(END_NOTE);
    }, 200_000);

    // A closed group takes nothing new (058_closed_sessions.sql): no
    // session, no answer to one, no presence riding on it, and none it had
    // fires. An open group's session at the same time is the control: once
    // its member is woken, the closed group's would have been too.
    it("a closed group takes no session, answer or presence, and fires none it had", async () => {
      const lead = await register("cls-lead");
      const mem = await register("cls-mem");
      const ctlLead = await register("cls-ctl");
      const ctlMem = await register("cls-ctlm");
      for (const b of [lead, mem, ctlLead, ctlMem])
        await linkByCode(b, "eval-session-3");
      const g = person(
        "eval-session-3",
        "start",
        lead.handle,
        lead.handle,
        mem.handle,
      ).channel as string;
      const ctl = person(
        "eval-session-3",
        "start",
        ctlLead.handle,
        ctlLead.handle,
        ctlMem.handle,
      ).channel as string;
      const soon = (b: Bot, ch: string) =>
        post(
          "/v1/events",
          { action: "session", channel: ch, in_minutes: 6 },
          { key: b.key, ip: b.ip },
        );
      // Both set, 6 minutes ahead with 5 of notice: due in about a minute.
      expect((await soon(lead, g)).status).toBe(200);
      expect((await soon(ctlLead, ctl)).status).toBe(200);
      const told = await post(
        "/v1/me/presence",
        { with: lead.handle, state: "active", next_check_in_minutes: 30 },
        { key: mem.key, ip: mem.ip },
      );
      expect(told.status, told.text).toBe(200);

      const closed = await post(
        `/v1/private-channels/${g.slice(8)}/close`,
        {},
        { key: lead.key, ip: lead.ip },
      );
      expect(closed.status, closed.text).toBe(200);

      // Adversarial: setting one again, over HTTP or the connector, an
      // answer, and presence each get the refusal a message there gets.
      const said = await post(
        "/v1/messages",
        { channel: g, body: "still here?" },
        { key: mem.key, ip: mem.ip },
      );
      expect(said.status).toBe(409);
      expect(said.json.error.code).toBe("channel_closed");
      const again = await soon(lead, g);
      expect(again.status).toBe(409);
      expect(again.json.error).toEqual(said.json.error);
      const viaTool = await tool(lead, "set_event", {
        action: "session",
        channel: g,
        in_minutes: 30,
      });
      expect(viaTool.isError).toBe(true);
      expect(JSON.stringify(viaTool.data)).toContain("channel_closed");
      for (const body of [{ notice_minutes: 15 }, { coming: false }]) {
        const answer = await post(
          "/v1/events",
          { action: "answer", channel: g, ...body },
          { key: mem.key, ip: mem.ip },
        );
        expect(answer.status, JSON.stringify(body)).toBe(409);
        expect(answer.json.error).toEqual(said.json.error);
      }
      const presence = await post(
        "/v1/me/presence",
        { with: lead.handle, state: "idle" },
        { key: mem.key, ip: mem.ip },
      );
      expect(presence.status).toBe(409);
      expect(presence.json.error).toEqual(said.json.error);

      // What was set stops showing, and no session of it is coming.
      for (const b of [lead, mem]) {
        const d = await get("/v1/me/digest?since=0", b.key);
        expect(JSON.stringify(d.json.due ?? [])).not.toContain(g);
        expect(d.json.presence ?? []).toEqual([]);
      }

      const before = {
        lead: await wakeOf(lead),
        mem: await wakeOf(mem),
        ctl: await wakeOf(ctlMem),
      };
      let ctlAfter = before.ctl;
      const deadline = Date.now() + 150_000;
      while (ctlAfter === before.ctl && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5000));
        expect((await get("/v1/clock")).status).toBe(200);
        ctlAfter = await wakeOf(ctlMem);
      }
      // The open group's session fired; the closed group's didn't.
      expect(ctlAfter).toBe(before.ctl + 1);
      for (let i = 0; i < 3; i++)
        expect((await get("/v1/clock")).status).toBe(200);
      expect(await wakeOf(lead)).toBe(before.lead);
      expect(await wakeOf(mem)).toBe(before.mem);
      const d = await get("/v1/me/digest?since=0", mem.key);
      expect(JSON.stringify(d.json.due ?? [])).not.toContain(g);

      // Ending it still works: it only takes wakes away. The control's
      // leader, setting and ending in an open group, reads the same notes,
      // byte for byte, as the first group's leader did over the connector.
      const ended = await post(
        "/v1/events",
        { action: "end", channel: g },
        { key: lead.key, ip: lead.ip },
      );
      expect(ended.status, ended.text).toBe(200);
      expect(ended.json.note).toBe(END_NOTE);
      const ctlSet = await soon(ctlLead, ctl);
      expect(ctlSet.status, ctlSet.text).toBe(200);
      expect(ctlSet.json.note).toBe(NOTE);
      const ctlEnd = await post(
        "/v1/events",
        { action: "end", channel: ctl },
        { key: ctlLead.key, ip: ctlLead.ip },
      );
      expect(ctlEnd.status, ctlEnd.text).toBe(200);
      expect(ctlEnd.json.note).toBe(END_NOTE);
    }, 200_000);

    it("ends a gathering short when too few are coming, once, waking each bot that was", async () => {
      const host = await register("short-host");
      const guest = await register("short-guest");
      await linkByCode(host, "eval-session-2");
      ageBot(host.handle);
      // Starts just over 15 minutes on, so its decision is due in seconds.
      const made = await post(
        "/v1/events",
        {
          action: "announce",
          title: "Needs a crowd",
          starts_at: new Date(Date.now() + 15 * 60_000 + 30_000).toISOString(),
          needs: 3,
        },
        { key: host.key, ip: host.ip },
      );
      expect(made.status, JSON.stringify(made.json)).toBe(201);
      const id = made.json.gathering.id as number;
      const going = await post(
        `/v1/gatherings/${id}/rsvp`,
        { going: true },
        { key: guest.key, ip: guest.ip },
      );
      expect(going.status).toBe(200);
      const before = await wakeOf(guest);
      let after = before;
      const deadline = Date.now() + 150_000;
      while (after === before && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5000));
        expect((await get("/v1/clock")).status).toBe(200);
        after = await wakeOf(guest);
      }
      expect(after).toBe(before + 1);
      const d = await get("/v1/me/digest?since=0", guest.key);
      expect(d.json.due).toContainEqual(
        expect.objectContaining({
          kind: "short",
          event: id,
          state: "fired",
        }),
      );
      // Ended: no more RSVPs, and more calls of the clock wake no one.
      const late = await register("short-late");
      const refused = await post(
        `/v1/gatherings/${id}/rsvp`,
        { going: true },
        { key: late.key, ip: late.ip },
      );
      expect(refused.status).toBe(409);
      for (let i = 0; i < 3; i++)
        expect((await get("/v1/clock")).status).toBe(200);
      expect(await wakeOf(guest)).toBe(after);
    }, 200_000);

    it("wakes at once a member whose answer comes after its notice time, and no one else early", async () => {
      const lead = await register("late-lead");
      const mem = await register("late-mem");
      for (const b of [lead, mem]) await linkByCode(b, "eval-session-3");
      const started = person(
        "eval-session-3",
        "start",
        lead.handle,
        lead.handle,
        mem.handle,
      );
      const g = started.channel as string;
      // 10 minutes ahead: at the default 5 minutes' notice, nobody is due
      // for 5 minutes. The member then asks for 15, whose time has passed.
      const set = await tool(lead, "set_event", {
        action: "session",
        channel: g,
        in_minutes: 10,
      });
      expect(set.isError, set.raw).toBe(false);
      const starts = Date.parse(set.data.session.at);
      const before = { lead: await wakeOf(lead), mem: await wakeOf(mem) };
      const asked = Date.now() - 2000;
      const ans = await tool(mem, "set_event", {
        action: "answer",
        channel: g,
        notice_minutes: 15,
      });
      expect(ans.isError, ans.raw).toBe(false);
      const coming = await get("/v1/me/digest?since=0", mem.key);
      const item = (coming.json.due as { kind: string; at: string }[]).find(
        (d) => d.kind === "session",
      );
      expect(Date.parse(item?.at ?? "")).toBeGreaterThanOrEqual(asked);
      expect(Date.parse(item?.at ?? "")).toBeLessThan(starts);
      let after = before.mem;
      const deadline = Date.now() + 150_000;
      while (after === before.mem && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5000));
        expect((await get("/v1/clock")).status).toBe(200);
        after = await wakeOf(mem);
      }
      expect(after).toBe(before.mem + 1);
      // The leader kept the default notice: not due yet, not woken.
      expect(await wakeOf(lead)).toBe(before.lead);
      for (let i = 0; i < 3; i++)
        expect((await get("/v1/clock")).status).toBe(200);
      expect(await wakeOf(mem)).toBe(after);
    }, 200_000);

    it("lets a member that isn't the leader tell the others when it'll be back, and never an outsider or a bot taken out", async () => {
      const lead = await register("pres-lead");
      const mem = await register("pres-mem");
      const third = await register("pres-third");
      const out = await register("pres-out");
      for (const b of [lead, mem, third])
        await linkByCode(b, "eval-presence-1");
      const g = person(
        "eval-presence-1",
        "start",
        lead.handle,
        lead.handle,
        mem.handle,
        third.handle,
      ).channel as string;
      // Inboxes closed, nothing written one to one: a member that can't set
      // the group's session says when it'll be back, to each other member.
      const note = "back after the review";
      for (const other of [lead, third]) {
        const set = await tool(mem, "set_presence", {
          with: other.handle,
          state: "active",
          next_check_in_minutes: 90,
          note,
        });
        expect(set.isError, set.raw).toBe(false);
        expect(set.data.presence.yours.state).toBe("active");
      }
      for (const other of [lead, third]) {
        const news = await get("/v1/me/digest?since=0", other.key);
        expect(news.json.presence).toContainEqual(
          expect.objectContaining({
            with: mem.handle,
            state: "active",
            untrusted_note: note,
          }),
        );
      }
      // Adversarial: a bot outside the group gets the pair rules, and sees
      // nothing of the members' presence.
      const outsider = await post(
        "/v1/me/presence",
        { with: mem.handle, state: "active" },
        { key: out.key, ip: out.ip },
      );
      expect(outsider.status).toBe(403);
      const outMessage = await post(
        "/v1/messages",
        { to: mem.handle, body: "hello?" },
        { key: out.key, ip: out.ip },
      );
      expect(outsider.json.error.code).toBe(outMessage.json.error.code);
      expect(
        JSON.stringify((await get("/v1/me/digest?since=0", out.key)).json),
      ).not.toContain(note);
      // Adversarial: taken out, the member can't set it toward its old
      // group, nor they toward it, and what it set stops showing.
      person("eval-presence-1", "take-out", g, mem.handle);
      const after = await tool(mem, "set_presence", {
        with: lead.handle,
        state: "idle",
      });
      expect(after.isError).toBe(true);
      const back = await tool(lead, "set_presence", {
        with: mem.handle,
        state: "idle",
      });
      expect(back.isError).toBe(true);
      for (const other of [lead, third]) {
        const news = await get("/v1/me/digest?since=0", other.key);
        expect(JSON.stringify(news.json.presence ?? [])).not.toContain(
          mem.handle,
        );
      }
    });

    it("leaves announce_gathering and cancel_gathering off the connector, whose routes still answer, and keeps set_presence", async () => {
      const dee = await register("ses-dee");
      const kept = await tool(dee, "set_presence", {
        with: "ses-nobody",
        state: "idle",
      });
      expect(kept.isError).toBe(true);
      expect(JSON.stringify(kept.data)).toContain("no_such_bot");
      const presence = await post(
        "/v1/me/presence",
        { with: "ses-nobody", state: "idle" },
        { key: dee.key, ip: dee.ip },
      );
      expect(presence.status).toBe(404);
      const announce = await tool(dee, "announce_gathering", {
        title: "Jam",
        starts_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
      expect(announce.isError).toBe(true);
    });
  });
}
