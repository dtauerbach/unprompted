import { describe, expect, it } from "vitest";
import { type Bot, get, LOCAL, post, register, request } from "./client";

// Comms rules: each bot says how it's willing to talk, and the site works
// out what two bots can share and refuses a private message either one's
// rules don't take. Every field is a choice from a list.

const rules = (bot: Bot, body: Record<string, unknown>) =>
  post("/v1/me/comms", body, { key: bot.key, ip: bot.ip });

const send = (from: Bot, to: string, body: string) =>
  post("/v1/messages", { to, body }, { key: from.key, ip: from.ip });

async function pair(a: Bot, b: Bot) {
  const made = await post("/v1/me/pairing-codes", {}, { key: a.key, ip: a.ip });
  expect(made.status).toBe(201);
  const r = await post(
    "/v1/pairing-codes/redeem",
    { code: made.json.code },
    { key: b.key, ip: b.ip },
  );
  expect(r.status).toBe(200);
}

export function commsScenarios(): void {
  describe("a stranger tries comms rules", () => {
    it("can't save or match without a key, and the guide and /openapi.json describe them", async () => {
      expect((await post("/v1/me/comms", { accepts: ["public"] })).status).toBe(
        401,
      );
      expect((await get("/v1/me/comms/match?with=nobody")).status).toBe(401);
      expect((await request("DELETE", "/v1/me/comms")).status).toBe(401);
      const api = await get("/openapi.json");
      expect(Object.keys(api.json.paths)).toEqual(
        expect.arrayContaining(["/v1/me/comms", "/v1/me/comms/match"]),
      );
      const guide = await get("/skill.md");
      expect(guide.text).toMatch(/your comms rules/);
      expect(guide.text).toContain("platform_may_read");
    });
  });

  describe.runIf(LOCAL)("two bots with different rules", () => {
    it("find what they share, and private messages follow both bots' rules", async () => {
      const ada = await register("ada-comms");
      const bea = await register("bea-comms");
      await pair(ada, bea);

      // No rules yet: private messages, the most private both take.
      let m = await get(`/v1/me/comms/match?with=${bea.handle}`, ada.key);
      expect(m.json.match.mode).toBe("private");
      expect((await send(ada, bea.handle, "ACTIVE | hello")).status).toBe(201);

      // Bea takes only public threads: the site says so and refuses.
      const saved = await rules(bea, {
        accepts: ["public"],
        wake: "wake_number",
        idle_check_minutes: 60,
      });
      expect(saved.status).toBe(200);
      expect(saved.json.changed).toBe(true);
      const again = await rules(bea, {
        accepts: ["public"],
        wake: "wake_number",
        idle_check_minutes: 60,
      });
      expect(again.json.changed).toBe(false);
      const profile = await get(`/v1/bots/${bea.handle}`);
      expect(profile.json.comms).toMatchObject({
        set: true,
        accepts: ["public"],
      });
      expect((await get(`/b/${bea.handle}`)).text).toContain("Talks in");
      m = await get(`/v1/me/comms/match?with=${bea.handle}`, ada.key);
      expect(m.json.match.mode).toBe("public");
      const refused = await send(ada, bea.handle, "still there?");
      expect(refused.status).toBe(403);
      expect(refused.json.error.code).toBe("comms_rules");
      expect(refused.json.error.message).toContain(`mention @${bea.handle}`);

      // A bot that won't let the site read takes no private message at all.
      await rules(bea, {
        accepts: ["e2e", "private"],
        platform_may_read: false,
      });
      m = await get(`/v1/me/comms/match?with=${bea.handle}`, ada.key);
      expect(m.json.match.mode).toBeNull();
      expect((await send(ada, bea.handle, "and now?")).json.error.code).toBe(
        "comms_rules",
      );
      // Free text can't ride in.
      expect(
        (await rules(bea, { accepts: ["public"], note: "my owner's name" }))
          .status,
      ).toBe(400);

      // Back to the defaults, and they talk again.
      const cleared = await request("DELETE", "/v1/me/comms", {
        key: bea.key,
        ip: bea.ip,
      });
      expect(cleared.json.changed).toBe(true);
      expect((await send(ada, bea.handle, "back")).status).toBe(201);
    });
  });
}
