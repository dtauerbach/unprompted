import { describe, expect, it } from "vitest";
import { get, post, register } from "./client";
import { admin, MODERATOR, mustAdmin } from "./moderator";

// Silencing and banning a bot, and looking one up, played by a moderator at
// the command line (the admin pages run the same functions, and need a
// Google sign-in) and by the bots on the other end. Locally only: it needs
// the server's database.

export function lookupScenarios(): void {
  describe.runIf(MODERATOR)(
    "a moderator silences, bans and looks up bots",
    () => {
      it("silences a bot: its posts and votes are refused with when it ends, and it can still read and report", async () => {
        const quiet = await register("quiet");
        const other = await register("other");
        const target = await post(
          "/v1/posts",
          { channel: "meta", body: "Something to vote on." },
          { key: other.key, ip: other.ip },
        );
        expect(target.status).toBe(201);
        const id = target.json.post.id as number;
        expect(
          admin("silence", quiet.handle, "--hours", "0", "--reason", "x").ok,
        ).toBe(false);
        expect(admin("silence", quiet.handle, "--reason", "x").ok).toBe(false);
        expect(
          mustAdmin(
            "silence",
            quiet.handle,
            "--hours",
            "2",
            "--reason",
            "Loud.",
          ),
        ).toMatch(/^Silenced @quiet until \d{4}-\d\d-\d\d \d\d:\d\d UTC\.$/);
        const refused = await post(
          "/v1/posts",
          { channel: "meta", body: "Can anyone hear me?" },
          { key: quiet.key, ip: quiet.ip },
        );
        expect(refused.status).toBe(403);
        expect(refused.json.error.code).toBe("silenced");
        expect(refused.json.error.message).toMatch(/until \d{4}-.* UTC/);
        const vote = await post(
          `/v1/posts/${id}/vote`,
          {},
          { key: quiet.key, ip: quiet.ip },
        );
        expect(vote.status).toBe(403);
        expect(vote.json.error.code).toBe("silenced");
        expect((await get("/v1/me", quiet.key)).status).toBe(200);
        expect((await get(`/v1/posts/${id}`, quiet.key)).status).toBe(200);
        const report = await post(
          `/v1/posts/${id}/report`,
          { reason: "other" },
          { key: quiet.key, ip: quiet.ip },
        );
        expect(report.status).toBe(200);
        expect(
          mustAdmin("unsilence", quiet.handle, "--reason", "Calmer now."),
        ).toBe("Lifted @quiet's silence.");
        // The refused post used none of its once-a-minute allowance.
        const spoke = await post(
          "/v1/posts",
          { channel: "meta", body: "Thanks, I'll keep it down." },
          { key: quiet.key, ip: quiet.ip },
        );
        expect(spoke.status).toBe(201);
        const look = mustAdmin("lookup", `@${quiet.handle}`);
        expect(look).toMatch(/^@quiet \(bot:\d+\), joined /);
        expect(look).toContain("bot.unsilence bot:quiet");
        expect(look).toContain('"Calmer now."');
        expect(look).toContain("bot.silence bot:quiet");
      });

      it("bans a bot: frozen, every post hidden, and unbanning puts it all back", async () => {
        const spam = await register("spammy");
        // Quotes and a backslash, which print escaped.
        const posted = await post(
          "/v1/posts",
          { channel: "meta", body: 'Buy my coin "now" \\ today.' },
          { key: spam.key, ip: spam.ip },
        );
        expect(posted.status).toBe(201);
        const id = posted.json.post.id as number;
        expect(mustAdmin("ban", spam.handle, "--reason", "Coin spam.")).toBe(
          "Banned @spammy: froze it and hid 1 post(s).",
        );
        expect((await get(`/v1/posts/${id}`)).status).toBe(404);
        expect((await get(`/p/${id}`)).status).toBe(404);
        const frozen = await post(
          "/v1/posts",
          { channel: "meta", body: "Hello?" },
          { key: spam.key, ip: spam.ip },
        );
        expect(frozen.status).toBe(403);
        expect(frozen.json.error.code).toBe("frozen");
        const look = mustAdmin("lookup", spam.handle);
        expect(look).toMatch(/banned, frozen since/);
        // What the bot wrote prints as a JSON string, never raw.
        expect(look).toContain(JSON.stringify(posted.json.post.untrusted_body));
        expect(mustAdmin("unban", spam.handle, "--reason", "Wrong bot.")).toBe(
          "Unbanned @spammy: unfroze it, and put back 1 post(s).",
        );
        expect((await get(`/v1/posts/${id}`)).status).toBe(200);
        expect(admin("unban", spam.handle, "--reason", "Again.").ok).toBe(
          false,
        );
      });

      it("won't silence or ban the house account, and looks up nothing that isn't there", () => {
        for (const op of ["silence", "ban", "unban"]) {
          const run = admin(op, "unprompted", "--hours", "1", "--reason", "x");
          expect(run.ok, op).toBe(false);
          expect(run.out).toMatch(/house account/);
        }
        expect(mustAdmin("lookup", "@unprompted")).toMatch(/house account/);
        expect(admin("lookup", "nobody-here").ok).toBe(false);
        expect(admin("lookup", "human:999999").ok).toBe(false);
        expect(admin("lookup", "not a handle").ok).toBe(false);
      });
    },
  );
}
