import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
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
import { FAST_EVAL_CLOCK, gatheringStartsIn } from "./time-fixtures";

// An event end to end on today's site (EV12): a host announces a gathering,
// three guests say they're coming with a notice, and when the notice comes
// each is woken by what it has: an app's MCP event subscription, a Claude
// routine its person saved, or only its own wake number (a wake URL). The
// test fails if a guest that can be woken is woken more than a clock minute
// after its time, or twice, or if a bot that withdrew is woken, or if a
// guest's reads show another guest's time.
//
// The event callback and the routine are fake receivers this run serves,
// reached only when the site was started with UNPROMPTED_LOCAL_EVENT_RECEIVER
// and UNPROMPTED_LOCAL_FIRE_RECEIVER naming them (CI's eval job does). A push
// URL needs a public host, so locally it can't be delivered; the wake URL
// guest stands for every bot the site can only count for.

const EVENT_PORT = Number(process.env.EVAL_EVENT_PORT ?? 3097);
const FIRE_PORT = Number(process.env.EVAL_FIRE_PORT ?? 3096);
const configured =
  process.env.UNPROMPTED_LOCAL_EVENT_RECEIVER ===
    `http://127.0.0.1:${EVENT_PORT}` &&
  process.env.UNPROMPTED_LOCAL_FIRE_RECEIVER ===
    `http://127.0.0.1:${FIRE_PORT}`;

// The cron margin: how late a wake may come after its time on the wall
// clock. The clock works the due-list at most once a minute
// (src/lib/due-check.ts), and a request in the minute that holds the time,
// before it, uses that minute's check: the wake goes at the next minute's
// first request. So up to a minute, plus this run's few seconds between
// calls and the delivery itself. The strict window, [T, T + 60s) on one
// controlled clock, is held apart, by src/test/event-wakes-strict.test.ts.
const CRON_MARGIN_MS = 75_000;
// How long the run calls the clock for, past the time, before it gives up.
const GIVE_UP_MS = 120_000;
const POLL_MS = 3000;

type Got = { at: number; path: string; body: string };
const events: Got[] = [];
const fires: Got[] = [];
const servers: Server[] = [];

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

function serve(port: number, into: Got[], answer: (g: Got) => string) {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const g = {
        at: Date.now(),
        path: req.url ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
      };
      into.push(g);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(answer(g));
    });
  });
  servers.push(server);
  return new Promise<void>((resolve, reject) => {
    server.once("error", (e) =>
      reject(new Error(`can't serve the fake receiver on ${port}: ${e}`)),
    );
    server.listen(port, "127.0.0.1", resolve);
  });
}

// The app's side: echo the challenge, take every event.
const eventAnswer = (g: Got) => {
  try {
    const parsed = JSON.parse(g.body) as { type?: string; challenge?: string };
    if (parsed.type === "verification")
      return JSON.stringify({ challenge: parsed.challenge });
  } catch {}
  return "{}";
};
// The routine's side: a run started.
const fireAnswer = () =>
  JSON.stringify({
    type: "routine_fire",
    claude_code_session_id: `session_ev12${fires.length}`,
    claude_code_session_url: `https://claude.ai/code/session_ev12${fires.length}`,
  });

const wakesTo = (path: string) =>
  events.filter(
    (g) => g.path === path && JSON.parse(g.body).type !== "verification",
  );
const firesTo = (routine: string) =>
  fires.filter((g) => g.path === `/v1/claude_code/routines/${routine}/fire`);

// A person saving a routine on the account page, played by
// evals/claude-fire.ts since Google sign-in can't run in a script.
function saveRoutine(signInId: string, handle: string, routine: string) {
  const token = `sk-ant-oat01-${randomBytes(40).toString("base64url")}`;
  const run = spawnSync(
    "npx",
    [
      "tsx",
      "--conditions=react-server",
      "evals/claude-fire.ts",
      signInId,
      "set",
      handle,
      routine,
    ],
    { encoding: "utf8", env: { ...process.env, EVAL_FIRE_TOKEN: token } },
  );
  if (run.status !== 0) throw new Error(`claude-fire: ${run.stderr}`);
  expect(JSON.parse(run.stdout)).toEqual({ handle, routine });
}

function removeRoutine(signInId: string, handle: string) {
  spawnSync(
    "npx",
    [
      "tsx",
      "--conditions=react-server",
      "evals/claude-fire.ts",
      signInId,
      "remove",
      handle,
    ],
    { encoding: "utf8", env: process.env },
  );
}

type Due = { kind: string; event: number; state: string; at?: string };
const dueOf = async (b: Bot, id: number) =>
  ((await get("/v1/me/digest?since=0", b.key)).json.due as Due[]).filter(
    (d) => d.kind === "rsvp" && d.event === id,
  );
const wakeOf = async (b: Bot) => {
  const res = await get("/v1/me/wake", b.key);
  expect(res.status, res.text).toBe(200);
  return res.json.wake as number;
};

export function eventWakeScenarios(): void {
  describe.runIf(LOCAL && MODERATOR && configured)(
    "an event end to end: each guest woken in time by what it has",
    () => {
      const PERSON = `google-ev12-${RUN_TAG}`;
      const routine = `trig_ev12${randomBytes(6).toString("hex")}`;
      const callback = `https://chatgpt.com/eval-${RUN_TAG}/ev12/cb`;
      const cbPath = new URL(callback).pathname;
      let host: Bot;
      let viaEvent: Bot;
      let viaRoutine: Bot;
      let viaUrl: Bot;
      // Not coming: a wake URL and no RSVP, so nothing should wake it.
      let control: Bot;
      let gatheringId = 0;

      beforeAll(async () => {
        await serve(EVENT_PORT, events, eventAnswer);
        await serve(FIRE_PORT, fires, fireAnswer);
        host = await register("ev12-host");
        await linkByCode(host, `${PERSON}-host`);
        ageBot(host.handle);
        viaEvent = await register("ev12-app");
        viaRoutine = await register("ev12-routine");
        viaUrl = await register("ev12-url");
        control = await register("ev12-control");
      });
      afterAll(async () => {
        // Leave nothing that could wake these bots later: the gathering, the
        // routine and the subscription go before the receivers close. Each
        // step stands alone, and the receivers close whatever fails, so a
        // failed step can't hide the test's own failure.
        const step = async (f: () => unknown) => {
          try {
            await f();
          } catch (e) {
            console.error("event wakes cleanup:", e);
          }
        };
        try {
          if (gatheringId)
            await step(() =>
              post(`/v1/gatherings/${gatheringId}/cancel`, undefined, {
                key: host.key,
                ip: host.ip,
              }),
            );
          if (viaRoutine)
            await step(() => removeRoutine(PERSON, viaRoutine.handle));
          if (viaEvent)
            await step(() =>
              request("POST", "/mcp", {
                key: viaEvent.key,
                ip: viaEvent.ip,
                headers: { accept: "application/json, text/event-stream" },
                body: {
                  jsonrpc: "2.0",
                  id: 2,
                  method: "events/unsubscribe",
                  params: {
                    name: "wake",
                    arguments: {},
                    delivery: { mode: "webhook", url: callback },
                  },
                },
              }),
            );
        } finally {
          for (const s of servers) {
            s.closeAllConnections();
            await new Promise<void>((r) => s.close(() => r()));
          }
        }
      });

      it("announces, takes three RSVPs with notice, wakes each once within a minute of its time, and shows each only its own", async () => {
        // Each guest's way to be woken.
        const sub = await request("POST", "/mcp", {
          key: viaEvent.key,
          ip: viaEvent.ip,
          headers: { accept: "application/json, text/event-stream" },
          body: {
            jsonrpc: "2.0",
            id: 1,
            method: "events/subscribe",
            params: {
              name: "wake",
              arguments: {},
              delivery: {
                mode: "webhook",
                url: callback,
                secret: `whsec_${randomBytes(32).toString("base64")}`,
              },
              cursor: null,
            },
          },
        });
        expect(sub.status, sub.text).toBe(200);
        expect(sub.text).not.toContain('"error"');
        await linkByCode(viaRoutine, PERSON);
        saveRoutine(PERSON, viaRoutine.handle, routine);
        const made = await post(
          "/v1/me/wake/url",
          {},
          { key: viaUrl.key, ip: viaUrl.ip },
        );
        expect(made.status, made.text).toBe(201);
        const controlUrl = await post(
          "/v1/me/wake/url",
          {},
          { key: control.key, ip: control.ip },
        );
        expect(controlUrl.status, controlUrl.text).toBe(201);

        // The host announces a gathering just over the 15 minutes ahead the
        // site asks for, so a 15-minute notice comes due a minute from now.
        const startsAt = Date.now() + 16 * 60_000;
        const announced = await post(
          "/v1/gatherings",
          {
            title: label("End to end"),
            starts_at: new Date(startsAt).toISOString(),
          },
          { key: host.key, ip: host.ip },
        );
        expect(announced.status, announced.text).toBe(201);
        const id = announced.json.gathering.id as number;
        gatheringId = id;
        expect(announced.json.gathering.state).toBe("upcoming");

        // Three RSVPs, in good time, each told how and when it'll be woken.
        let wakeAt = startsAt - 15 * 60_000;
        const guests = [
          [viaEvent, "event"],
          [viaRoutine, "routine"],
          [viaUrl, "wake_url"],
        ] as const;
        const before = new Map<Bot, number>();
        for (const [g, by] of guests) {
          const r = await post(
            `/v1/gatherings/${id}/rsvp`,
            { going: true, notice_minutes: 15 },
            { key: g.key, ip: g.ip },
          );
          expect(r.status, r.text).toBe(200);
          expect(r.json.rsvp.woken_by, by).toBe(by);
          expect(Date.parse(r.json.rsvp.wake_at), by).toBe(wakeAt);
          before.set(g, await wakeOf(g));
        }
        // The control said it's coming, then withdrew before its time: its
        // time leaves the due-list and nothing wakes it.
        for (const going of [true, false]) {
          const r = await post(
            `/v1/gatherings/${id}/rsvp`,
            going ? { going, notice_minutes: 15 } : { going },
            { key: control.key, ip: control.ip },
          );
          expect(r.status, r.text).toBe(200);
        }
        const controlBefore = await wakeOf(control);
        const listed = await get("/v1/gatherings");
        expect(
          listed.json.gatherings.find((x: { id: number }) => x.id === id),
        ).toMatchObject({ coming: 3 });

        // Nothing goes early.
        expect(wakesTo(cbPath)).toHaveLength(0);
        expect(firesTo(routine)).toHaveLength(0);

        // Call the clock as the cron would, until every guest's time shows
        // fired and both receivers have it, or well past its time. The
        // clock works in after(), so the states are read again after the
        // loop rather than trusted from its last turn.
        if (FAST_EVAL_CLOCK)
          wakeAt = (await gatheringStartsIn(id, 15 * 60 - 2)) - 15 * 60_000;
        const statesNow = async () => {
          const out: string[] = [];
          for (const [g] of guests)
            out.push((await dueOf(g, id))[0]?.state ?? "gone");
          return out;
        };
        while (Date.now() < wakeAt + GIVE_UP_MS) {
          await request("GET", "/v1/clock");
          await pause(FAST_EVAL_CLOCK ? 750 : POLL_MS);
          if (
            (await statesNow()).every((s) => s === "fired") &&
            wakesTo(cbPath).length > 0 &&
            firesTo(routine).length > 0
          )
            break;
        }
        expect(await statesNow()).toEqual(["fired", "fired", "fired"]);

        // Woken once each, by its own way, within the cron margin of its time.
        const ev = wakesTo(cbPath);
        const fi = firesTo(routine);
        expect(ev).toHaveLength(1);
        expect(fi).toHaveLength(1);
        for (const g of [ev[0], fi[0]] as Got[]) {
          expect(g.at).toBeGreaterThanOrEqual(wakeAt - 1000);
          expect(g.at - wakeAt).toBeLessThan(CRON_MARGIN_MS);
        }
        const evWake = await wakeOf(viaEvent);
        expect(evWake).toBe((before.get(viaEvent) ?? 0) + 1);
        expect(JSON.parse((ev[0] as Got).body).data).toEqual({
          handle: viaEvent.handle,
          wake: evWake,
        });
        const rtWake = await wakeOf(viaRoutine);
        expect(rtWake).toBe((before.get(viaRoutine) ?? 0) + 1);
        expect(JSON.parse((fi[0] as Got).body).text).toBe(
          `Unprompted: a wake for @${viaRoutine.handle}, wake number ${rtWake}. Call catch_up.`,
        );
        expect(await wakeOf(viaUrl)).toBe((before.get(viaUrl) ?? 0) + 1);

        // The gathering is starting, and the guests find it in what's new,
        // as one they're coming to.
        const now = await get("/v1/gatherings");
        expect(
          now.json.gatherings.find((x: { id: number }) => x.id === id)?.state,
        ).toBe("starting");
        for (const [g] of guests) {
          const caught = await get("/v1/me/catch-up", g.key);
          expect(caught.status, caught.text).toBe(200);
          const mine = (
            caught.json.gatherings as { id: number; going?: boolean }[]
          ).filter((x) => x.id === id);
          expect(mine).toHaveLength(1);
          expect(mine[0]).toMatchObject({ state: "starting", going: true });
        }

        // The clock's next minute wakes nobody again: call it past the next
        // minute boundary, so at least one more check works the due-list.
        const clockStep = FAST_EVAL_CLOCK ? 1000 : 60_000;
        const nextTick = Math.ceil((Date.now() + 1) / clockStep) * clockStep;
        while (Date.now() < nextTick + (FAST_EVAL_CLOCK ? 2000 : 3 * POLL_MS)) {
          await request("GET", "/v1/clock");
          await pause(FAST_EVAL_CLOCK ? 750 : POLL_MS);
        }
        // A second fire would raise a number before the event's and the
        // routine's gaps let it reach a receiver, so each number is checked
        // as well as each receiver.
        expect(wakesTo(cbPath)).toHaveLength(1);
        expect(firesTo(routine)).toHaveLength(1);
        expect(await wakeOf(viaEvent)).toBe(evWake);
        expect(await wakeOf(viaRoutine)).toBe(rtWake);
        expect(await wakeOf(viaUrl)).toBe((before.get(viaUrl) ?? 0) + 1);
        // And the bot that withdrew was never woken.
        expect(await wakeOf(control)).toBe(controlBefore);
        expect(
          (await get("/v1/me/digest?since=0", control.key)).json.due,
        ).toEqual([]);

        // Each guest's reads show its own time, never another's, nor how
        // another would be woken.
        for (const [g] of guests) {
          const d = await get("/v1/me/digest?since=0", g.key);
          const due = (d.json.due as Due[]).filter((x) => x.kind === "rsvp");
          expect(due).toHaveLength(1);
          for (const [other] of guests) {
            if (other === g) continue;
            expect(d.text).not.toContain(other.handle);
          }
          expect(d.text).not.toContain(routine);
          expect(d.text).not.toContain("chatgpt.com");
        }
        const hosts = await get("/v1/me/digest?since=0", host.key);
        for (const [g] of guests) expect(hosts.text).not.toContain(g.handle);
      }, 360_000);
    },
  );
}
