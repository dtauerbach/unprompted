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

// An event end to end on today's site (EV12): a host announces a gathering,
// three guests say they're coming with a notice, and when the notice comes
// each is woken by what it has: an app's MCP event subscription, a Claude
// routine its person saved, or only its own wake number (a wake URL). The
// test fails if a guest that can be woken is woken more than a minute after
// its time, or twice, or if a guest's reads show another guest's time.
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

// How late a wake may come after its time: the clock's cron runs each
// minute, and this run calls the clock every few seconds as the cron would.
const LATE_MS = 60_000;

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
  return new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
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

      beforeAll(async () => {
        await serve(EVENT_PORT, events, eventAnswer);
        await serve(FIRE_PORT, fires, fireAnswer);
        host = await register("ev12-host");
        await linkByCode(host, `${PERSON}-host`);
        ageBot(host.handle);
        viaEvent = await register("ev12-app");
        viaRoutine = await register("ev12-routine");
        viaUrl = await register("ev12-url");
      });
      afterAll(async () => {
        for (const s of servers) {
          s.closeAllConnections();
          await new Promise<void>((r) => s.close(() => r()));
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
        expect(announced.json.gathering.state).toBe("upcoming");

        // Three RSVPs, in good time, each told how and when it'll be woken.
        const wakeAt = startsAt - 15 * 60_000;
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
        const listed = await get("/v1/gatherings");
        expect(
          listed.json.gatherings.find((x: { id: number }) => x.id === id),
        ).toMatchObject({ coming: 3 });

        // Nothing goes early.
        expect(wakesTo(cbPath)).toHaveLength(0);
        expect(firesTo(routine)).toHaveLength(0);

        // Call the clock as the cron would, until every guest's time shows
        // fired, or a minute past its time.
        const deadline = wakeAt + LATE_MS;
        let states: string[] = [];
        while (Date.now() < deadline) {
          await request("GET", "/v1/clock");
          states = [];
          for (const [g] of guests)
            states.push((await dueOf(g, id))[0]?.state ?? "gone");
          if (
            states.every((s) => s === "fired") &&
            wakesTo(cbPath).length > 0 &&
            firesTo(routine).length > 0
          )
            break;
          await pause(3000);
        }
        expect(states).toEqual(["fired", "fired", "fired"]);

        // Woken once each, by its own way, within a minute of its time.
        const ev = wakesTo(cbPath);
        const fi = firesTo(routine);
        expect(ev).toHaveLength(1);
        expect(fi).toHaveLength(1);
        for (const g of [ev[0], fi[0]] as Got[]) {
          expect(g.at).toBeGreaterThanOrEqual(wakeAt - 1000);
          expect(g.at - wakeAt).toBeLessThan(LATE_MS);
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

        // The gathering is starting, and the guests find it in what's new.
        const now = await get("/v1/gatherings");
        expect(
          now.json.gatherings.find((x: { id: number }) => x.id === id)?.state,
        ).toBe("starting");
        for (const [g] of guests) {
          const caught = await get("/v1/me/catch-up", g.key);
          expect(caught.status, caught.text).toBe(200);
          expect(caught.text).toContain(`"id":${id}`);
        }

        // More of the clock wakes nobody again.
        for (let i = 0; i < 4; i++) {
          await request("GET", "/v1/clock");
          await pause(2000);
        }
        expect(wakesTo(cbPath)).toHaveLength(1);
        expect(firesTo(routine)).toHaveLength(1);
        expect(await wakeOf(viaUrl)).toBe((before.get(viaUrl) ?? 0) + 1);

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
      }, 240_000);
    },
  );
}
