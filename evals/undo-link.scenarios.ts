import { describe, expect, it } from "vitest";
import { get, LOCAL, post, register, request } from "./client";
import { enterLinkCode, ownerCode } from "./humans.scenarios";
import { MODERATOR } from "./moderator";

// A bot undoes a link it didn't mean, in its first day, and only a link it
// made with a link code. Its two bots sign up late in the run, under the
// lift before the digest, so they don't tip the spike count for the
// moderation scenarios that register right after the humans'.

export function undoLinkScenarios(): void {
  describe.runIf(LOCAL && MODERATOR)("a bot undoes a wrong link", () => {
    it("lets a bot undo a link it didn't mean, within its first day", async () => {
      const b = await register("undoes-a-link");
      // No link yet: nothing to undo; no key: nothing at all.
      const none = await request("DELETE", "/v1/me/link", {
        key: b.key,
        ip: b.ip,
      });
      expect(none.status).toBe(409);
      expect(none.json.error.code).toBe("not_linked");
      expect((await request("DELETE", "/v1/me/link", {})).status).toBe(401);
      // A stranger gets the bot's link code and enters it.
      const res = await post("/v1/me/link-code", {}, { key: b.key, ip: b.ip });
      expect(enterLinkCode("eval-stranger-1", res.json.link_code)).toBe(
        b.handle,
      );
      expect((await get("/v1/me", b.key)).json.bot.claimed).toBe(true);
      // The bot's own agent ends it, and is told how to link to its person.
      const undo = await request("DELETE", "/v1/me/link", {
        key: b.key,
        ip: b.ip,
      });
      expect(undo.status).toBe(200);
      expect(undo.json).toMatchObject({ unlinked: true, left_channels: [] });
      expect(undo.json.note).toMatch(/give it to them alone/);
      expect(JSON.stringify(undo.json)).not.toContain("eval-stranger");
      expect((await get("/v1/me", b.key)).json.bot.claimed).toBe(false);
      // Its own person links it with a new code.
      const next = await post("/v1/me/link-code", {}, { key: b.key, ip: b.ip });
      expect(enterLinkCode("eval-human-9", next.json.link_code)).toBe(b.handle);
    });

    it("won't let a key end a link made at sign-up, even in the first day", async () => {
      // Whoever holds a key that leaked in a bot's first day can't end its
      // person's link and link it to themselves.
      const b = await register("signed-up-linked", {
        owner_code: ownerCode("eval-human-10"),
      });
      expect((await get("/v1/me", b.key)).json.bot.claimed).toBe(true);
      const undo = await request("DELETE", "/v1/me/link", {
        key: b.key,
        ip: b.ip,
      });
      expect(undo.status).toBe(409);
      expect(undo.json.error.code).toBe("linked_at_sign_up");
      expect((await get("/v1/me", b.key)).json.bot.claimed).toBe(true);
    });
  });
}
