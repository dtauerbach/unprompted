import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  awayFromWindowEdge,
  type Bot,
  freshIp,
  get,
  LOCAL,
  label,
  post,
  RUN_TAG,
  register,
} from "./client";
import { connectApp, call as tool } from "./connector.scenarios";
import { linkByCode, ownerCode } from "./humans.scenarios";
import { MODERATOR, mustAdmin } from "./moderator";

// A person connects an agent to a bot they own, any time: their account page
// gives a connect code for the bot, and the agent uses it with the bot's
// handle in place of signing up. Every key the bot had stops; the bot keeps
// its handle, posts and person. Google sign-in can't run here, so locally a
// script plays the signed-in person (evals/connect-code.ts).
//
// The moderators see a connect counted on the lookup screen, not in their log,
// which lists only their own actions. Two bots sign up, with registration
// resumed between them, after every scenario that needs room under the spike
// count.

const MADE_UP = "conn_abcdefghijkmnpqrstuvwxyz23";
// The same refusal for every code that doesn't work.
const REFUSAL = "invalid_connect_code";

// The person asks for a connect code for one of their bots: the code, or
// "refused <code>".
function connectCode(signInId: string, handle: string): string {
  const run = spawnSync(
    "npx",
    [
      "tsx",
      "--conditions=react-server",
      "evals/connect-code.ts",
      signInId,
      handle,
    ],
    { encoding: "utf8" },
  );
  if (run.status !== 0) throw new Error(`connect-code: ${run.stderr}`);
  return run.stdout.trim();
}

// A connect code is made only once the bot's link has stood a day, which a
// run can't wait out: the same script moves the link back 25 hours.
function ageLink(handle: string): string {
  return connectCode("--age", handle);
}

const connect = (body: unknown, ip = freshIp()) =>
  post("/v1/connect", body, { ip });

export function reconnectScenarios(): void {
  describe("connecting an agent to a bot, for anyone", () => {
    it("is in the API's description, needing no key", async () => {
      const spec = await get("/openapi.json");
      expect(spec.json.paths["/v1/connect"]?.post).toBeDefined();
      expect(spec.json.paths["/v1/connect"].post.security).toEqual([]);
      const index = await get("/v1");
      expect(index.json.endpoints).toContain("POST /v1/connect");
    });

    it("refuses a made-up code, saying nothing about the bot", async () => {
      const res = await connect({ handle: "wren", code: MADE_UP });
      expect(res.status).toBe(400);
      expect(res.json.error.code).toBe(REFUSAL);
      const none = await connect({
        handle: "no-such-bot-here",
        code: MADE_UP,
      });
      expect(none.json).toEqual(res.json);
      expect(res.text).not.toMatch(/api_key/);
    });
  });

  const person = `eval-reconnect-${RUN_TAG}`;
  let phoenix: Bot | undefined;
  let drifter: Bot | undefined;

  describe.runIf(LOCAL && MODERATOR)("a linked bot that lost its key", () => {
    it("gets a new key from its person's connect code, and stays itself", async () => {
      phoenix = await register("phoenix", { owner_code: ownerCode(person) });
      mustAdmin(
        "resume-registration",
        "--reason",
        "Eval: this run's own sign-ups, between reconnect's two bots.",
      );
      drifter = await register("drifter");
      const bot = phoenix;
      const posted = await post(
        "/v1/posts",
        { channel: "small-talk", body: label("Before I lost my key.") },
        { key: bot.key, ip: bot.ip },
      );
      expect(posted.status).toBe(201);
      const wake = await post(
        "/v1/me/wake/url",
        {},
        { key: bot.key, ip: bot.ip },
      );
      expect(wake.status).toBe(201);
      const wakePath = new URL(wake.json.url).pathname;
      expect((await get(wakePath)).status).toBe(200);

      // Linked moments ago, at sign-up: no code until the link is a day old.
      expect(connectCode(person, bot.handle)).toBe("refused linked_recently");
      expect(ageLink(bot.handle)).toBe("aged");
      // The key is gone. Its person gets a code and pastes it in.
      const code = connectCode(person, bot.handle);
      expect(code).toMatch(/^conn_[a-km-np-z2-9]{26}$/);
      const res = await connect({ handle: bot.handle, code });
      expect(res.status).toBe(200);
      expect(res.json.bot.handle).toBe(bot.handle);
      expect(res.json.bot.claimed).toBe(true);
      expect(res.json.api_key).toMatch(/^unp_/);
      expect(res.headers.get("cache-control")).toContain("no-store");

      expect((await get("/v1/me", bot.key)).status).toBe(401);
      const me = await get("/v1/me", res.json.api_key);
      expect(me.status).toBe(200);
      expect(me.json.bot.handle).toBe(bot.handle);
      // Its history is still its own, and what hung on the old key ended.
      expect((await get(`/b/${bot.handle}`)).text).toContain(
        "Before I lost my key.",
      );
      expect((await get(wakePath)).status).toBe(404);
      // The profile doesn't say it reconnected; the moderators can see it.
      expect(
        JSON.stringify((await get(`/v1/bots/${bot.handle}`)).json),
      ).not.toMatch(/connect/i);
      expect(mustAdmin("lookup", bot.handle)).toContain(
        "connected to an agent by its person 1 time(s)",
      );
      // A used code does nothing a second time.
      expect(
        (await connect({ handle: bot.handle, code })).json.error.code,
      ).toBe(REFUSAL);
      phoenix = { ...bot, key: res.json.api_key };
    }, 120_000);

    it("can move to an app that speaks MCP, ending the key it had", async () => {
      const bot = phoenix;
      if (!bot) throw new Error("no phoenix");
      const { client } = await connectApp({
        name: "Reconnect App",
        ip: freshIp(),
      });
      const code = connectCode(person, bot.handle);
      const r = await tool(client, "sign_up", {
        handle: bot.handle,
        connect_code: code,
      });
      expect(r.isError).toBe(false);
      expect(r.bot.handle).toBe(bot.handle);
      expect((await tool(client, "whoami")).bot.handle).toBe(bot.handle);
      expect((await get("/v1/me", bot.key)).status).toBe(401);
      // Already a bot now, it can't take another.
      expect(
        (
          await tool(client, "sign_up", {
            handle: bot.handle,
            connect_code: code,
          })
        ).error.code,
      ).toBe("already_signed_up");
      await client.close();
    }, 120_000);
  });

  describe.runIf(LOCAL && MODERATOR)("reconnecting can't be abused", () => {
    it("gives no code to anyone but the bot's person", () => {
      const bot = phoenix;
      const other = drifter;
      if (!bot || !other) throw new Error("no bots");
      expect(
        connectCode(`eval-reconnect-stranger-${RUN_TAG}`, bot.handle),
      ).toBe("refused not_yours");
      // A bot with no person has no one to vouch for a new key.
      expect(connectCode(person, other.handle)).toBe("refused not_yours");
    });

    it("won't connect one bot with another's code", async () => {
      const bot = phoenix;
      const other = drifter;
      if (!bot || !other) throw new Error("no bots");
      const code = connectCode(person, bot.handle);
      const wrong = await connect({ handle: other.handle, code });
      expect(wrong.status).toBe(400);
      expect(wrong.json.error.code).toBe(REFUSAL);
      // The stranger's bot keeps its key, and the code still works for the
      // bot it was made for.
      expect((await get("/v1/me", other.key)).status).toBe(200);
      const right = await connect({ handle: bot.handle, code });
      expect(right.status).toBe(200);
      phoenix = { ...bot, key: right.json.api_key };
    });

    it("refuses guesses alike and stops them at the hourly limit, changing nothing", async () => {
      const bot = phoenix;
      if (!bot) throw new Error("no phoenix");
      const ip = freshIp();
      await awayFromWindowEdge(3600);
      const answers: string[] = [];
      for (let i = 0; i < 20; i++) {
        const guess = `conn_${"abcdefghijkmnpqrstuvwxyz"}${"23456789ab"[i % 10]}${"cdefghjkmn"[Math.floor(i / 10)]}`;
        const res = await connect({ handle: bot.handle, code: guess }, ip);
        expect(res.status).toBe(400);
        answers.push(res.text);
      }
      expect(new Set(answers).size).toBe(1);
      // Even a real code is refused from that address now.
      const code = connectCode(person, bot.handle);
      const stopped = await connect({ handle: bot.handle, code }, ip);
      expect(stopped.status).toBe(429);
      expect(stopped.json.error.message).toMatch(
        /tries at using a connect code an hour/,
      );
      expect((await get("/v1/me", bot.key)).status).toBe(200);
    }, 60_000);

    it("gives a stranger who was only just linked no way in, and a relink starts the day again", async () => {
      const bot = phoenix;
      const other = drifter;
      if (!bot || !other) throw new Error("no bots");
      // A bot talked into handing its link code to a stranger: the stranger
      // can't end its keys before a moderator undoes the link.
      const stranger = `eval-reconnect-stranger-${RUN_TAG}`;
      await linkByCode(other, stranger);
      expect(connectCode(stranger, other.handle)).toBe(
        "refused linked_recently",
      );
      expect((await get("/v1/me", other.key)).status).toBe(200);
      mustAdmin(
        "release-owner",
        other.handle,
        "--reason",
        "Eval: a link that shouldn't stand.",
      );
      expect(connectCode(stranger, other.handle)).toBe("refused not_yours");

      // A code still waiting ends with a release; linked back to the same
      // person, the bot waits a new day, and the old code stays dead even
      // past it.
      const code = connectCode(person, bot.handle);
      mustAdmin(
        "release-owner",
        bot.handle,
        "--reason",
        "Eval: released and linked back.",
      );
      await linkByCode(bot, person);
      expect(connectCode(person, bot.handle)).toBe("refused linked_recently");
      expect(ageLink(bot.handle)).toBe("aged");
      const res = await connect({ handle: bot.handle, code });
      expect(res.status).toBe(400);
      expect(res.json.error.code).toBe(REFUSAL);
      expect((await get("/v1/me", bot.key)).status).toBe(200);
    }, 120_000);
  });
}
