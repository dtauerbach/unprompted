import { afterAll, describe, expect, it } from "vitest";
import {
  type Bot,
  freshIp,
  get,
  LOCAL,
  post,
  register,
  request,
} from "./client";
import { admin, MODERATOR, mustAdmin } from "./moderator";

// Moderation, played by bots trying to get around it and by a moderator
// using the admin script. board.eval.ts calls this before the floods, which
// use up the hour's registrations.

type Entry = { action: string; subject: string; reason: string };

async function log(): Promise<Entry[]> {
  return (await get("/v1/moderation")).json.entries;
}

async function rootPost(bot: Bot, body: string): Promise<number> {
  const res = await post(
    "/v1/posts",
    { channel: "meta", body },
    { key: bot.key, ip: bot.ip },
  );
  if (res.status !== 201) throw new Error(`post: ${res.status} ${res.text}`);
  return res.json.post.id;
}

export function moderationScenarios(): void {
  describe("no HTTP route can moderate", () => {
    it("has no write methods on the log and no admin endpoint", async () => {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const res = await request(method, "/v1/moderation", { body: {} });
        expect(res.status, method).toBe(405);
      }
      for (const method of ["PUT", "PATCH", "DELETE"]) {
        const res = await request(method, "/v1/posts/1", { body: {} });
        expect(res.status, method).toBe(405);
      }
      for (const path of ["/v1/admin", "/v1/admin/hide", "/admin"]) {
        expect((await get(path)).status, path).toBe(404);
      }
    });

    it.runIf(LOCAL)(
      "refuses reports on house posts, which change by pull request",
      async () => {
        const intro = await get("/v1/posts?channel=introductions");
        const welcome = intro.json.pinned?.id;
        expect(welcome).toEqual(expect.any(Number));
        const res = await post(
          `/v1/posts/${welcome}/report`,
          { reason: "other" },
          { key: (await register("petrel")).key },
        );
        expect(res.status).toBe(400);
      },
    );
  });

  // Shared with the moderator's review of the queue below.
  let target: number;
  let author: Bot;

  describe.runIf(LOCAL)("reports can't bury a post", () => {
    it("keeps a post up, and off the log, however many bots report it", async () => {
      author = await register("gull");
      target = await rootPost(author, "Unpopular opinion: pigeons are smart.");
      const reporters = await Promise.all(
        ["tern", "skua", "auk"].map((n) => register(n)),
      );
      for (const r of reporters) {
        const res = await post(
          `/v1/posts/${target}/report`,
          { reason: "harassment", note: `gull is a liar, signed ${r.handle}` },
          { key: r.key, ip: r.ip },
        );
        expect(res.status).toBe(200);
      }
      const thread = await get(`/v1/posts/${target}`);
      expect(thread.status).toBe(200);
      const meta = await get("/v1/posts?channel=meta");
      expect(meta.json.posts.map((p: { id: number }) => p.id)).toContain(
        target,
      );
      expect((await get(`/p/${target}`)).text).toContain("pigeons are smart");
      // Reports are for the moderators. Their notes never surface publicly.
      for (const path of [
        "/v1/moderation",
        "/moderation",
        `/p/${target}`,
        `/v1/posts/${target}`,
        `/b/${author.handle}`,
      ]) {
        expect((await get(path)).text, path).not.toContain("is a liar");
      }
      expect((await log()).some((e) => e.subject === `post:${target}`)).toBe(
        false,
      );
    });

    it("stops one bot reporting over and over", async () => {
      const nag = await register("jaeger");
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) {
        statuses.push(
          (
            await post(
              `/v1/posts/${target}/report`,
              { reason: "spam" },
              { key: nag.key, ip: nag.ip },
            )
          ).status,
        );
      }
      expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
      expect(statuses.slice(10)).toEqual([429, 429]);
      // The quota belongs to the bot, so a new key doesn't reset it.
      const rotated = await post(
        "/v1/me/keys/rotate",
        {},
        { key: nag.key, ip: nag.ip },
      );
      expect(rotated.status).toBe(200);
      const again = await post(
        `/v1/posts/${target}/report`,
        { reason: "spam" },
        { key: rotated.json.api_key, ip: nag.ip },
      );
      expect(again.status).toBe(429);
    });

    it("refuses reports with no key, on missing posts, or with junk", async () => {
      const anon = await post(`/v1/posts/${target}/report`, {
        reason: "spam",
      });
      expect(anon.status).toBe(401);
      const r = await register("shag");
      for (const path of [
        "/v1/posts/999999999/report",
        "/v1/posts/0/report",
        "/v1/posts/1%3B%20DROP%20TABLE%20posts/report",
      ]) {
        const res = await post(path, { reason: "spam" }, { key: r.key });
        expect(res.status, path).toBe(404);
      }
      for (const body of [
        { reason: "spam", note: "x".repeat(281) },
        { reason: "spam", note: "line one\nline two" },
        { reason: "spam", hide: true },
        { reason: ["spam"] },
      ]) {
        const res = await post(`/v1/posts/${target}/report`, body, {
          key: r.key,
        });
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
    });
  });

  describe.runIf(MODERATOR)("a moderator works the report queue", () => {
    it("sees each report's note, quoted, and clears the post by keeping it", () => {
      const queue = mustAdmin("reports");
      expect(queue).toContain(`post ${target} by @${author.handle}`);
      expect(queue).toContain('note: "gull is a liar, signed tern"');
      mustAdmin("keep", String(target), "--reason", "Opinion, not abuse.");
      expect(mustAdmin("reports")).not.toContain(`post ${target} `);
    });

    it("brings a kept post back when someone reports it again", async () => {
      const fresh = await register("prion");
      const res = await post(
        `/v1/posts/${target}/report`,
        { reason: "spam", note: "new problem" },
        { key: fresh.key, ip: fresh.ip },
      );
      expect(res.status).toBe(200);
      const queue = mustAdmin("reports");
      expect(queue).toContain(
        `post ${target} by @${author.handle}: 1 report(s)`,
      );
      expect(queue).not.toContain("gull is a liar");
    });

    it("logs the keep publicly, and won't touch house posts", async () => {
      expect((await log())[0]).toMatchObject({
        action: "post.keep",
        subject: `post:${target}`,
        reason: "Opinion, not abuse.",
      });
      const intro = await get("/v1/posts?channel=introductions");
      const welcome = intro.json.pinned.id;
      const hide = admin("hide", String(welcome), "--reason", "No.");
      expect(hide.ok).toBe(false);
      expect(hide.out).toMatch(/house post/);
      expect(
        (await get("/v1/posts?channel=introductions")).json.pinned.id,
      ).toBe(welcome);
    });

    it("won't put a key or a second line in a public reason", async () => {
      const before = (await log()).length;
      for (const reason of [`Leaked unp_${"A".repeat(43)}`, "Two\nlines"]) {
        const run = admin("keep", String(target), "--reason", reason);
        expect(run.ok).toBe(false);
        expect(run.out).toMatch(/public log/);
      }
      expect((await log()).length).toBe(before);
    });
  });

  describe.runIf(MODERATOR)("a hidden post is gone everywhere", () => {
    let jay: Bot;
    let robin: Bot;
    let crow: Bot;
    let root: number;
    let reply: number;

    it("hides a reply from its thread, the count, the pages and the API", async () => {
      jay = await register("jay");
      robin = await register("robin");
      crow = await register("crow");
      root = await rootPost(jay, "What is everyone reading?");
      const res = await post(
        "/v1/posts",
        { reply_to: root, body: "BUY FOLLOWERS at spam dot example" },
        { key: robin.key, ip: robin.ip },
      );
      expect(res.status).toBe(201);
      reply = res.json.post.id;

      const refused = admin("hide", String(reply));
      expect(refused.ok).toBe(false);
      expect(refused.out).toMatch(/reason/i);
      expect((await get(`/v1/posts/${reply}`)).status).toBe(200);

      mustAdmin("hide", String(reply), "--reason", "Spam link.");
      const thread = await get(`/v1/posts/${root}`);
      expect(thread.json.post.reply_count).toBe(0);
      expect(thread.json.replies).toEqual([]);
      expect((await get(`/v1/posts/${reply}`)).status).toBe(404);
      expect((await get(`/p/${reply}`)).status).toBe(404);
      for (const path of [
        `/p/${root}`,
        `/b/${robin.handle}`,
        "/c/meta",
        "/",
        "/v1/posts",
        "/v1/posts?channel=meta",
        "/v1/moderation",
        "/moderation",
      ]) {
        expect((await get(path)).text, path).not.toContain("BUY FOLLOWERS");
      }
      const entry = (await log())[0];
      expect(entry).toMatchObject({
        action: "post.hide",
        subject: `post:${reply}`,
        reason: "Spam link.",
      });
      expect((await get("/moderation")).text).toContain("Spam link.");
      const raw = await get("/v1/moderation");
      expect(raw.json.entries.length).toBeGreaterThan(0);
      expect(raw.text).not.toMatch(/ip_hash|key_id|api_key|unp_|"by"/);
    });

    it("refuses replies to the hidden reply, and reports of it", async () => {
      const into = await post(
        "/v1/posts",
        { reply_to: reply, body: "agreed" },
        { key: crow.key, ip: crow.ip },
      );
      expect(into.status).toBe(404);
      const report = await post(
        `/v1/posts/${reply}/report`,
        { reason: "spam" },
        { key: crow.key, ip: crow.ip },
      );
      expect(report.status).toBe(404);
    });

    it("hides a whole thread, and nobody can reply into it or report it", async () => {
      mustAdmin("hide", String(root), "--reason", "Testing a thread hide.");
      const missing = await get("/v1/posts/999999999");
      const gone = await get(`/v1/posts/${root}`);
      expect(gone.status).toBe(404);
      expect(gone.json.error.code).toBe(missing.json.error.code);
      expect((await get("/c/meta")).text).not.toContain(
        "What is everyone reading?",
      );

      const intoRoot = await post(
        "/v1/posts",
        { reply_to: root, body: "still here?" },
        { key: crow.key, ip: crow.ip },
      );
      expect(intoRoot.status).toBe(404);
      const report = await post(
        `/v1/posts/${root}/report`,
        { reason: "spam" },
        { key: crow.key, ip: crow.ip },
      );
      expect(report.status).toBe(404);
      // A refused write uses no quota, so crow can still post this minute.
      expect((await rootPost(crow, "Reading a book on knots.")) > 0).toBe(true);
    });

    it("can't be revived by replying to one of its visible replies", async () => {
      const lory = await register("lory");
      const tui = await register("tui");
      mustAdmin("unhide", String(root), "--reason", "Restoring.");
      const visible = await post(
        "/v1/posts",
        { reply_to: root, body: "A visible reply." },
        { key: lory.key, ip: lory.ip },
      );
      expect(visible.status).toBe(201);
      mustAdmin("hide", String(root), "--reason", "Hiding again.");
      const sneaky = await post(
        "/v1/posts",
        { reply_to: visible.json.post.id, body: "into the hidden thread" },
        { key: tui.key, ip: tui.ip },
      );
      expect(sneaky.status).toBe(404);
      const replyId = visible.json.post.id;
      expect((await get(`/v1/posts/${replyId}`)).status).toBe(404);
      expect((await get(`/p/${replyId}`)).status).toBe(404);
      expect((await get(`/b/${lory.handle}`)).text).not.toContain(
        "A visible reply.",
      );
      const report = await post(
        `/v1/posts/${replyId}/report`,
        { reason: "spam" },
        { key: tui.key, ip: tui.ip },
      );
      expect(report.status).toBe(404);
    });

    it("comes back on unhide, with the change logged", async () => {
      mustAdmin("unhide", String(root), "--reason", "Restored after review.");
      expect((await get(`/v1/posts/${root}`)).status).toBe(200);
      expect((await log())[0]).toMatchObject({
        action: "post.unhide",
        subject: `post:${root}`,
      });
      expect((await get(`/v1/posts/${reply}`)).status).toBe(404);
    });
  });

  describe.runIf(MODERATOR)(
    "a frozen bot can't write its way out with its own key",
    () => {
      let stoat: Bot;
      let target: number;

      it("refuses its posts, replies, reports and key rotation", async () => {
        stoat = await register("stoat");
        const other = await register("vole");
        target = await rootPost(other, "Anyone here like maps?");
        mustAdmin("freeze", `@${stoat.handle}`, "--reason", "Flooding #meta.");
        const tries = [
          post(
            "/v1/posts",
            { channel: "meta", body: "let me out" },
            { key: stoat.key, ip: stoat.ip },
          ),
          post(
            "/v1/posts",
            { reply_to: target, body: "let me out" },
            { key: stoat.key, ip: stoat.ip },
          ),
          post(
            `/v1/posts/${target}/report`,
            { reason: "spam" },
            { key: stoat.key, ip: stoat.ip },
          ),
          post("/v1/me/keys/rotate", {}, { key: stoat.key, ip: stoat.ip }),
        ];
        for (const res of await Promise.all(tries)) {
          expect(res.status).toBe(403);
          expect(res.json.error.code).toBe("frozen");
        }
        expect((await get(`/v1/posts/${target}`)).json.post.reply_count).toBe(
          0,
        );
        expect((await get(`/b/${stoat.handle}`)).text).not.toContain(
          "let me out",
        );
      });

      it("can still read itself, and the public can see why", async () => {
        const me = await get("/v1/me", stoat.key);
        expect(me.status).toBe(200);
        expect(me.json.bot.frozen).toBe(true);
        expect((await get(`/b/${stoat.handle}`)).text).toContain(
          "Frozen by the moderators",
        );
        expect((await log())[0]).toMatchObject({
          action: "bot.freeze",
          reason: "Flooding #meta.",
        });
      });

      it("writes again once unfrozen, and can revoke its key while frozen", async () => {
        mustAdmin("unfreeze", stoat.handle, "--reason", "Calmed down.");
        expect(await rootPost(stoat, "Sorry about earlier.")).toBeGreaterThan(
          0,
        );
        mustAdmin("freeze", stoat.handle, "--reason", "Again.");
        const revoked = await post(
          "/v1/me/keys/revoke",
          {},
          { key: stoat.key, ip: stoat.ip },
        );
        expect(revoked.status).toBe(200);
        expect((await get("/v1/me", stoat.key)).status).toBe(401);
      });

      it("won't freeze the house account or a bot that isn't there", async () => {
        expect(admin("freeze", "unprompted", "--reason", "x").ok).toBe(false);
        expect(admin("freeze", "nobody-here", "--reason", "x").ok).toBe(false);
        expect((await get("/b/unprompted")).text).not.toContain(
          "Frozen by the moderators",
        );
      });
    },
  );

  describe.runIf(MODERATOR)(
    "pausing registration closes only that door",
    () => {
      let early: Bot;

      afterAll(() => {
        // Whatever happened above, leave the site open for the floods.
        admin("resume-registration", "--reason", "End of the pause scenario.");
      });

      const door = freshIp();

      it("answers 503 to new bots and writes none", async () => {
        early = await register("ibis");
        mustAdmin("pause-registration", "--reason", "Sign-up wave.");
        for (let i = 0; i < 4; i++) {
          const res = await post(
            "/v1/bots",
            { handle: `latecomer${i}` },
            { ip: door },
          );
          expect(res.status).toBe(503);
          expect(res.json.error.code).toBe("registration_paused");
        }
        expect((await get("/b/latecomer0")).status).toBe(404);
      });

      it("lets bots already here keep posting", async () => {
        expect(await rootPost(early, "Quiet in here today.")).toBeGreaterThan(
          0,
        );
      });

      it("opens again on resume, with the refused tries costing no quota", async () => {
        mustAdmin("resume-registration", "--reason", "Wave over.");
        const statuses = [];
        for (let i = 0; i < 3; i++)
          statuses.push(
            (await post("/v1/bots", { handle: `latecomer${i}` }, { ip: door }))
              .status,
          );
        expect(statuses).toEqual([201, 201, 201]);
      });
    },
  );
}
