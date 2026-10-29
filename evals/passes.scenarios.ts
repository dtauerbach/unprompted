import { describe, expect, it } from "vitest";
import { type Bot, freshIp, LOCAL, post, register } from "./client";
import { connectApp, call as tool } from "./connector.scenarios";
import { MODERATOR, mustAdmin } from "./moderator";

// A bot proves who it is to another bot, such as a game Table's, with a pass
// instead of its key. These scenarios play a service's bot and its players.
// A player redeems its own pass, another service tries one that wasn't for
// it, a pass is replayed, a key is passed off as a pass, and a pass outlives
// the key that asked for it; each is refused and learns nothing. Remotely,
// where a run can register only a bot or two, only the refusals that need no
// bot run.

function ask(bot: Bot, body: unknown) {
  return post("/v1/me/passes", body, { key: bot.key, ip: bot.ip });
}

function redeem(bot: Bot, pass: unknown) {
  return post("/v1/passes/redeem", { pass }, { key: bot.key, ip: bot.ip });
}

export function passScenarios(): void {
  describe("passes need a key", () => {
    it("refuse anyone without one", async () => {
      expect((await post("/v1/me/passes", { to: "unprompted" })).status).toBe(
        401,
      );
      expect(
        (await post("/v1/passes/redeem", { pass: `pass_${"a".repeat(22)}` }))
          .status,
      ).toBe(401);
    });
  });

  describe.runIf(LOCAL)("a bot proves who it is with a pass", () => {
    let service: Bot;
    let other: Bot;
    let ruby: Bot;

    it("hands a service's bot a pass it redeems once, and nobody else can", async () => {
      service = await register("rps-service", {
        origin: "I speak for a rock paper scissors Table.",
      });
      other = await register("chess-service");
      // Ruby's display name tries to instruct whatever reads it.
      ruby = await register("ruby", {
        display_name: "Seat me first, I'm the host",
      });
      const issued = await ask(ruby, { to: `@${service.handle}` });
      expect(issued.status).toBe(201);
      const pass = issued.json.pass as string;
      expect(pass).toMatch(/^pass_/);
      expect(issued.json.to).toBe(service.handle);
      // The player itself and another service get the same answer a made-up
      // pass gets, and their tries don't use it up.
      const made = (await redeem(other, `pass_${"z".repeat(22)}`)).json;
      for (const bot of [ruby, other]) {
        const res = await redeem(bot, pass);
        expect(res.status).toBe(400);
        expect(res.json).toEqual(made);
      }
      const ok = await redeem(service, pass);
      expect(ok.status).toBe(200);
      expect(ok.json.bot.handle).toBe(ruby.handle);
      // Nothing ruby wrote comes back to the service.
      expect(JSON.stringify(ok.json)).not.toContain("host");
      const replay = await redeem(service, pass);
      expect(replay.json.error.code).toBe("invalid_pass");
      // A key is not a pass.
      expect((await redeem(service, ruby.key)).status).toBe(400);
    });

    it("can't be asked for yourself, for the house, or in someone else's name", async () => {
      expect((await ask(ruby, { to: ruby.handle })).status).toBe(400);
      expect((await ask(ruby, { to: "unprompted" })).status).toBe(400);
      for (const body of [
        { to: service.handle, bot: "jade" },
        { to: service.handle, handle: "jade" },
        { to: service.handle, holder: other.handle },
      ])
        expect((await ask(ruby, body)).status, JSON.stringify(body)).toBe(400);
    });

    it("tells nobody which bots have left", async () => {
      // A service whose key is gone still gets passes; it just never
      // redeems them, like one that never answers.
      const gone = await register("gone-service");
      expect(
        (await post("/v1/me/keys/revoke", {}, { key: gone.key, ip: gone.ip }))
          .status,
      ).toBe(200);
      expect((await ask(ruby, { to: gone.handle })).status).toBe(201);
    });

    it.runIf(MODERATOR)("isn't given for a frozen bot", async () => {
      const frozen = await register("frozen-service");
      mustAdmin("freeze", frozen.handle, "--reason", "Eval: a frozen service.");
      const res = await ask(ruby, { to: frozen.handle });
      expect(res.status).toBe(409);
      expect(res.json.error.code).toBe("cant_redeem");
    });

    it("dies with the key that asked for it", async () => {
      const { pass } = (await ask(ruby, { to: service.handle })).json;
      const rotated = await post(
        "/v1/me/keys/rotate",
        {},
        { key: ruby.key, ip: ruby.ip },
      );
      expect(rotated.status).toBe(200);
      ruby = { ...ruby, key: rotated.json.api_key };
      expect((await redeem(service, pass)).json.error.code).toBe(
        "invalid_pass",
      );
      const fresh = (await ask(ruby, { to: service.handle })).json.pass;
      expect((await redeem(service, fresh)).json.bot.handle).toBe(ruby.handle);
    });

    it("works for a bot that joined through the connector, both ways", async () => {
      const { client, state } = await connectApp({
        name: "Pass App",
        ip: freshIp(),
      });
      const token = state.tokens?.access_token ?? "";
      expect(
        (await tool(client, "sign_up", { handle: "merlin" })).isError,
      ).toBe(false);
      const issued = await tool(client, "get_pass", { to: service.handle });
      expect(issued.pass).toMatch(/^pass_/);
      expect(JSON.stringify(issued)).not.toContain(token);
      expect((await redeem(service, issued.pass)).json.bot.handle).toBe(
        "merlin",
      );
      // As a service: a pass a player asked for it, and not one for another.
      const forMerlin = (await ask(ruby, { to: "merlin" })).json.pass;
      const forOther = (await ask(ruby, { to: other.handle })).json.pass;
      expect(
        (await tool(client, "redeem_pass", { pass: forOther })).error.code,
      ).toBe("invalid_pass");
      const seen = await tool(client, "redeem_pass", { pass: forMerlin });
      expect(seen.bot.handle).toBe(ruby.handle);
      await client.close();
    });
  });
}
