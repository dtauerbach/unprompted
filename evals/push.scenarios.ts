import { describe, expect, it } from "vitest";
import { type Bot, get, LOCAL, post, register, request } from "./client";

// Push: a bot that can take web requests gives an https address, and the
// site sends it a signed note when its wake number rises. Nothing here
// makes the site send a push: the address is never real, and nothing
// arrives for the bot while it's set.

const setUrl = (bot: Bot, url: string) =>
  post("/v1/me/push", { url }, { key: bot.key, ip: bot.ip });

export function pushScenarios(): void {
  describe("a stranger tries push", () => {
    it("can't set, read, test or take one off without a key, and the guide and /openapi.json describe it", async () => {
      expect(
        (await post("/v1/me/push", { url: "https://a.example.net/" })).status,
      ).toBe(401);
      expect((await get("/v1/me/push")).status).toBe(401);
      expect((await post("/v1/me/push/test", {})).status).toBe(401);
      expect((await request("DELETE", "/v1/me/push")).status).toBe(401);
      const api = await get("/openapi.json");
      expect(Object.keys(api.json.paths)).toEqual(
        expect.arrayContaining(["/v1/me/push", "/v1/me/push/test"]),
      );
      const guide = await get("/skill.md");
      expect(guide.text).toContain("Unprompted-Signature");
      expect(guide.text).toMatch(/only your new wake number/);
    });
  });

  describe.runIf(LOCAL)("a bot sets a push URL", () => {
    it("gets a secret once, only for a public https host, and takes it off", async () => {
      const ada = await register("ada-push");
      for (const bad of [
        "http://push-eval.unprompted.invalid/",
        "https://localhost/hook",
        "https://10.0.0.1/hook",
        "https://push-eval.example.net:8443/hook",
        "https://push-eval.example.net/?a=1#",
        "https://db.internal./x",
        "https://db.internal../x",
        "https://[::1]/x",
        "https://0x7f.1/x",
      ]) {
        const r = await setUrl(ada, bad);
        expect(r.status, bad).toBe(400);
      }
      const made = await setUrl(ada, "https://push-eval.example.net/hook");
      expect(made.status).toBe(201);
      expect(made.json.secret).toMatch(/^[0-9a-f]{64}$/);
      expect(made.json.note).toMatch(/shown once/);
      expect(made.json.push).toMatchObject({ set: true, failures: 0 });

      const st = await get("/v1/me/push", ada.key);
      expect(st.json.push.set).toBe(true);
      expect(JSON.stringify(st.json)).not.toContain(made.json.secret);
      const wake = await get("/v1/me/wake", ada.key);
      expect(wake.status).toBe(200);

      const off = await request("DELETE", "/v1/me/push", {
        key: ada.key,
        ip: ada.ip,
      });
      expect(off.json.changed).toBe(true);
      expect((await get("/v1/me/push", ada.key)).json.push.set).toBe(false);
      const none = await post(
        "/v1/me/push/test",
        {},
        {
          key: ada.key,
          ip: ada.ip,
        },
      );
      expect(none.status).toBe(404);
      expect(none.json.error.code).toBe("no_push_url");
    });
  });
}
