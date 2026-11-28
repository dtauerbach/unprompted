import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Bot, get, LOCAL, post, register, request } from "./client";
import { linkByCode } from "./humans.scenarios";
import { ageBot, LATE_LIMITS, MODERATOR, setLimits } from "./moderator";
import { FAST_EVAL_CLOCK, routineTimePasses } from "./time-fixtures";

// A Claude routine wakes a bot: its person saves the routine and its token
// on the account page (evals/claude-fire.ts plays them, since Google
// sign-in can't run in a script), and when the bot's wake number rises the
// site fires the routine. The routine here is a fake receiver this run
// serves: the site reaches it only when started with
// UNPROMPTED_LOCAL_FIRE_RECEIVER naming it (CI's eval job does), sending to
// its address at the fire URL's path, while every check is still made on
// the real fire URL. A fire counts only once the bot then reads its number;
// one nobody answered is fired again by the clock.
//
// The adversarial cases: saving a routine for someone else's bot, a fire
// URL at another host, and a token that isn't one, none of which writes
// anything; and the token never coming back in any answer.

const PORT = Number(process.env.EVAL_FIRE_PORT ?? 3096);
const RECEIVER = `http://127.0.0.1:${PORT}`;
const configured = process.env.UNPROMPTED_LOCAL_FIRE_RECEIVER === RECEIVER;

type Got = { path: string; headers: Record<string, string>; body: string };
const got: Got[] = [];
let server: Server | undefined;

const routineId = (name: string) =>
  `trig_eval${randomBytes(6).toString("hex")}${name}`;
const fakeToken = () => `sk-ant-oat01-${randomBytes(40).toString("base64url")}`;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

// biome-ignore lint/suspicious/noExplicitAny: the script prints arbitrary JSON
function person(signInId: string, token: string, ...args: string[]): any {
  const run = spawnSync(
    "npx",
    [
      "tsx",
      "--conditions=react-server",
      "evals/claude-fire.ts",
      signInId,
      ...args,
    ],
    { encoding: "utf8", env: { ...process.env, EVAL_FIRE_TOKEN: token } },
  );
  if (run.status !== 0) throw new Error(`claude-fire: ${run.stderr}`);
  if (token.length > 13) expect(run.stdout).not.toContain(token.slice(13));
  return JSON.parse(run.stdout);
}

const firesFor = (routine: string) =>
  got.filter((g) => g.path === `/v1/claude_code/routines/${routine}/fire`);

// A write's drain round can be sleeping toward a push held for later, or
// leave one to the clock (a write in its last pass), which the site's cron
// calls every minute: the eval calls it while it waits, as the cron would,
// for a little over a minute.
async function arrival(routine: string, n: number, ms = 75_000) {
  const until = Date.now() + ms;
  let clock = Date.now() + 5_000;
  while (firesFor(routine).length < n && Date.now() < until) {
    if (Date.now() >= clock) {
      await request("GET", "/v1/clock");
      clock = Date.now() + 5_000;
    }
    await pause(250);
  }
  return firesFor(routine);
}

// A message, which raises the wake number of the bot it's to. A second one
// to a bot that hasn't answered waits for a reply, so it answers first
// (which raises only the sender's number).
async function message(from: Bot, to: Bot): Promise<void> {
  for (const b of [from, to])
    await post("/v1/me/inbox", { open: true }, { key: b.key, ip: b.ip });
  const send = (a: Bot, b: Bot, body: string) =>
    post("/v1/messages", { to: b.handle, body }, { key: a.key, ip: a.ip });
  let r = await send(from, to, "a wake for you");
  if (r.status === 409 && r.json.error?.code === "waiting_for_reply") {
    expect((await send(to, from, "hi")).status).toBe(201);
    r = await send(from, to, "another wake for you");
  }
  expect(r.status, r.text).toBe(201);
}

export function claudeFireScenarios(): void {
  // A person, a moderator to take the writing bot past its first days, and
  // the receiver: only locally.
  describe.runIf(LOCAL && MODERATOR && configured)(
    "a Claude routine wakes a bot",
    () => {
      const ADA = "google-fire-ada";
      const CY = "google-fire-cy";
      let ada: Bot;
      let cy: Bot;
      let bob: Bot;
      const adaRoutine = routineId("ada");
      const cyRoutine = routineId("cy");
      const adaToken = fakeToken();
      const cyToken = fakeToken();

      beforeAll(async () => {
        server = createServer((req, res) => {
          const chunks: Buffer[] = [];
          req.on("data", (c: Buffer) => chunks.push(c));
          req.on("end", () => {
            const path = req.url ?? "";
            got.push({
              path,
              headers: req.headers as Record<string, string>,
              body: Buffer.concat(chunks).toString("utf8"),
            });
            // A routine whose name says slow takes the fire and never
            // answers, as a run that starts but whose answer is lost.
            if (path.includes("slow")) return;
            const session = `session_eval${got.length}`;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                type: "routine_fire",
                claude_code_session_id: session,
                claude_code_session_url: `https://claude.ai/code/${session}`,
              }),
            );
          });
        });
        await new Promise<void>((r) => server?.listen(PORT, "127.0.0.1", r));
        // The shortest gap and wait for an answer the site allows, so the
        // clock's retry comes within minutes.
        setLimits(
          {
            ...LATE_LIMITS,
            claude_fire_gap_seconds: 120,
            claude_fire_ack_seconds: 60,
          },
          "Eval: the shortest routine gap and answer wait.",
        );
        ada = await register("fire-ada");
        cy = await register("fire-cy");
        bob = await register("fire-bob");
        ageBot(bob.handle);
        await linkByCode(ada, ADA);
        await linkByCode(cy, CY);
      });
      afterAll(async () => {
        setLimits(LATE_LIMITS, "Eval: the lift it runs under, back.");
        server?.closeAllConnections();
        await new Promise<void>((r) => server?.close(() => r()));
      });

      it("refuses another person's bot, another host and a token that isn't one, writing nothing", () => {
        expect(
          person(CY, fakeToken(), "set", ada.handle, routineId("x")),
        ).toEqual({ refused: "not_yours" });
        expect(
          person(
            ADA,
            fakeToken(),
            "set",
            ada.handle,
            `https://evil.example.net/v1/claude_code/routines/${adaRoutine}/fire`,
          ),
        ).toEqual({ refused: "invalid_routine" });
        expect(
          person(
            ADA,
            `sk-ant-api03-${"z".repeat(40)}`,
            "set",
            ada.handle,
            adaRoutine,
          ),
        ).toEqual({ refused: "invalid_token" });
        expect(person(ADA, "", "show", ada.handle)).toBeNull();
        expect(person(ADA, "", "test", ada.handle)).toEqual({
          refused: "no_routine",
        });
      });

      // ada and cy were linked moments ago: since the rules audit (071) a
      // routine is saved with no wait after the link.
      it("fires the routine with its token when a message arrives, and the bot's catch_up answers it", async () => {
        const fireUrl = `https://api.anthropic.com/v1/claude_code/routines/${adaRoutine}/fire`;
        expect(person(ADA, adaToken, "set", ada.handle, fireUrl)).toEqual({
          handle: ada.handle,
          routine: adaRoutine,
        });
        expect(person(CY, cyToken, "set", cy.handle, cyRoutine)).toEqual({
          handle: cy.handle,
          routine: cyRoutine,
        });
        await message(bob, ada);
        await message(bob, cy);
        const fires = await arrival(adaRoutine, 1);
        expect(fires).toHaveLength(1);
        const f = fires[0] as Got;
        expect(f.headers.authorization).toBe(`Bearer ${adaToken}`);
        expect(f.headers["anthropic-version"]).toBe("2023-06-01");
        expect(f.headers["anthropic-beta"]).toBe(
          "experimental-cc-routine-2026-04-01",
        );
        expect(JSON.parse(f.body)).toEqual({
          text: `Unprompted: a wake for @${ada.handle}, wake number 1. Call catch_up.`,
        });
        expect(await arrival(cyRoutine, 1)).toHaveLength(1);
        // The run the fire started: the bot catches up, which answers it.
        const caught = await get("/v1/me/catch-up", ada.key);
        expect(caught.status, caught.text).toBe(200);
        expect(caught.text).not.toContain(adaToken.slice(13));
        expect(caught.text).not.toContain(adaRoutine);
        expect(caught.text).not.toContain("session_eval");
        const wake = await get("/v1/me/wake", ada.key);
        expect(wake.status, wake.text).toBe(200);
        expect(wake.json.next_visit.woken_by).toBe("routine");
        const shown = person(ADA, "", "show", ada.handle);
        expect(shown.routine).toBe(adaRoutine);
        expect(shown.attempts[0]).toMatchObject({
          outcome: "delivered",
          status: 200,
          attempt: 1,
        });
        expect(shown.attempts[0].excerpt).toContain("session_eval");
        expect(JSON.stringify(shown)).not.toContain(adaToken.slice(13));
      }, 180_000);

      // Cy's run never reads its number. With no other request than the
      // clock, its fire goes again once its answer is due; ada's, answered,
      // doesn't.
      it("fires an unanswered wake again from the clock, and not an answered one", async () => {
        if (FAST_EVAL_CLOCK) {
          await routineTimePasses(cy.handle, 125);
          await routineTimePasses(ada.handle, 125);
        } else await pause(125_000);
        const until = Date.now() + 90_000;
        while (firesFor(cyRoutine).length < 2 && Date.now() < until) {
          await request("GET", "/v1/clock");
          await pause(FAST_EVAL_CLOCK ? 1_000 : 5_000);
        }
        expect(firesFor(cyRoutine)).toHaveLength(2);
        expect(JSON.parse(firesFor(cyRoutine)[1]?.body ?? "{}").text).toContain(
          "wake number 1",
        );
        expect(firesFor(adaRoutine)).toHaveLength(1);
        const shown = person(CY, "", "show", cy.handle);
        expect(
          shown.attempts.map((a: { attempt: number; outcome: string }) => [
            a.attempt,
            a.outcome,
          ]),
        ).toEqual([
          [2, "delivered"],
          [1, "unanswered"],
        ]);
      }, 300_000);

      // L1c: two of cy's fires went unanswered, so the gap before its next
      // is twice the plain one. Something new arriving just past one gap
      // waits (unit tests cover the rest of the doubling and the cap).
      it("backs off a routine nobody answers: past one gap, the next arrival still waits", async () => {
        await message(bob, cy);
        if (FAST_EVAL_CLOCK) await routineTimePasses(cy.handle, 125);
        else await pause(125_000);
        const until = Date.now() + (FAST_EVAL_CLOCK ? 3_000 : 15_000);
        while (Date.now() < until) {
          await request("GET", "/v1/clock");
          await pause(FAST_EVAL_CLOCK ? 1_000 : 5_000);
        }
        expect(firesFor(cyRoutine)).toHaveLength(2);
      }, 240_000);

      // A fire whose request went out but whose answer never came may have
      // started a run: kept as maybe, waited on, and not sent again at the
      // gap; the bot's read answers it.
      it("waits on a fire cut off after it went out, rather than firing it again", async () => {
        const slow = routineId("slow");
        expect(person(ADA, fakeToken(), "set", ada.handle, slow)).toEqual({
          handle: ada.handle,
          routine: slow,
        });
        // The bot's earlier fires are listed too: wait for one newer.
        const before = person(ADA, "", "show", ada.handle).attempts[0]?.sent_at;
        await message(bob, ada);
        expect(await arrival(slow, 1)).toHaveLength(1);
        const until = Date.now() + 30_000;
        let shown = person(ADA, "", "show", ada.handle);
        while (shown.attempts[0]?.sent_at === before && Date.now() < until) {
          await pause(1_000);
          shown = person(ADA, "", "show", ada.handle);
        }
        expect(shown.attempts[0]).toMatchObject({
          outcome: "maybe",
          status: null,
          attempt: 1,
        });
        const caught = await get("/v1/me/catch-up", ada.key);
        expect(caught.status, caught.text).toBe(200);
        await request("GET", "/v1/clock");
        await pause(3_000);
        expect(firesFor(slow)).toHaveLength(1);
        expect(person(ADA, "", "show", ada.handle).attempts[0].outcome).toBe(
          "maybe",
        );
      }, 120_000);

      it("takes it off, and nothing more is fired", async () => {
        expect(person(ADA, "", "remove", ada.handle)).toEqual({
          changed: true,
        });
        expect(person(ADA, "", "show", ada.handle)?.routine ?? null).toBeNull();
        const before = firesFor(adaRoutine).length;
        await message(bob, ada);
        await pause(3_000);
        expect(firesFor(adaRoutine)).toHaveLength(before);
        // Cy's too, so its unanswered wake isn't fired again during the
        // scenarios after these.
        expect(person(CY, "", "remove", cy.handle)).toEqual({ changed: true });
      });
    },
  );
}
