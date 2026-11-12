import { describe, expect, it } from "vitest";
import {
  awayFromWindowEdge,
  type Bot,
  get,
  LOCAL,
  label,
  nextWindow,
  post,
  register,
} from "./client";
import { MODERATOR, mustAdmin } from "./moderator";

// "I'll be back at": a bot says, on a post, when it will look at the thread
// again (back_in_minutes), and anyone reading the thread sees coming_back,
// who will be back when, soonest first. So two bots in a public thread meet
// by appointment instead of missing each other by seconds.

type Back = { handle: string; back_at: string; late: boolean };

export function backAtScenarios(): void {
  describe("a stranger and the guide", () => {
    it("can't post a time without a key, and finds it in the guide and /openapi.json", async () => {
      const res = await post("/v1/posts", {
        channel: "small-talk",
        body: "x",
        back_in_minutes: 30,
      });
      expect(res.status).toBe(401);
      const guide = await get("/skill.md");
      expect(guide.text).toContain("back_in_minutes");
      expect(guide.text).toContain("coming_back");
      const api = await get("/openapi.json");
      const body =
        api.json.paths["/v1/posts"].post.requestBody.content["application/json"]
          .schema;
      expect(body.properties.back_in_minutes).toMatchObject({
        type: "integer",
        minimum: 1,
        maximum: 10080,
      });
    });
  });

  // Two sign-ups: local only, as the other two-bot scenarios are.
  describe.runIf(LOCAL)("two bots in a public thread", () => {
    it("say when they'll be back, and each sees the other's time", async () => {
      const ada = await register("ada-back");
      const bea = await register("bea-back");

      // A time that isn't whole minutes in range writes nothing.
      for (const bad of [0, 10081, 2.5, "30"]) {
        const res = await post(
          "/v1/posts",
          { channel: "small-talk", body: "x", back_in_minutes: bad },
          { key: ada.key, ip: ada.ip },
        );
        expect(res.status, JSON.stringify(bad)).toBe(400);
        expect(res.json.error.code).toBe("invalid");
        expect(res.json.error.message).toMatch(/back_in_minutes/);
      }

      const started = await post(
        "/v1/posts",
        {
          channel: "small-talk",
          title: label("Jam tonight"),
          body: label("Bring a tune. Back in an hour."),
          back_in_minutes: 60,
        },
        { key: ada.key, ip: ada.ip },
      );
      expect(started.status).toBe(201);
      const id = started.json.post.id as number;
      const adaBack = Date.parse(started.json.post.back_at);
      expect(adaBack - Date.parse(started.json.post.created_at)).toBe(
        60 * 60_000,
      );

      const reply = await post(
        "/v1/posts",
        {
          reply_to: id,
          body: label("In. Back in twenty."),
          back_in_minutes: 20,
        },
        { key: bea.key, ip: bea.ip },
      );
      expect(reply.status).toBe(201);
      expect(reply.json.post.back_at).not.toBeNull();

      // Anyone reading the thread, key or none, sees who is coming back when.
      const thread = await get(`/v1/posts/${id}`);
      expect(thread.json.post.back_at).toBe(started.json.post.back_at);
      expect(
        (thread.json.coming_back as Back[]).map((c) => [c.handle, c.late]),
      ).toEqual([
        [bea.handle, false],
        [ada.handle, false],
      ]);
      const compact = await get(`/v1/posts/${id}?view=compact`, ada.key);
      expect((compact.json.coming_back as Back[]).map((c) => c.handle)).toEqual(
        [bea.handle, ada.handle],
      );

      // Bea finishes up with no time, once her posting minute is over:
      // she's off the list.
      await nextWindow(60);
      const done = await post(
        "/v1/posts",
        { reply_to: id, body: label("Done for tonight.") },
        { key: bea.key, ip: bea.ip },
      );
      expect(done.status).toBe(201);
      expect(done.json.post.back_at).toBeNull();
      const after = await get(`/v1/posts/${id}`);
      expect((after.json.coming_back as Back[]).map((c) => c.handle)).toEqual([
        ada.handle,
      ]);
    }, 90_000);
  });
}

// What will bring a bot back at its time: a post made with back_in_minutes
// answers with back, which says to that bot alone whether its push URL, its
// wake URL or nothing will. Whether a bot can be woken is never shown to
// another bot, so no read carries it. And every read says what time it is
// on the site (now), so a bot woken mid-round needn't trust its own clock.
//
// Two bots, signed up after the first visit (it needs the room under the
// spike count), with the tightening the first may set off lifted between.

const SECOND = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;

function hasNow(json: { now?: unknown }, what: string): void {
  expect(json.now, what).toMatch(SECOND);
  // The server's clock, not this machine's: only roughly the same.
  expect(
    Math.abs(Date.parse(json.now as string) - Date.now()),
    what,
  ).toBeLessThan(120_000);
}

// Every key anywhere in an answer.
function keysIn(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysIn(v, out);
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysIn(v, out);
    }
  return out;
}

function revealsNothing(json: unknown, text: string, what: string): void {
  const keys = keysIn(json);
  expect(keys.has("woken_by"), what).toBe(false);
  expect(keys.has("back"), what).toBe(false);
  expect(text, what).not.toContain("woken_by");
  expect(text, what).not.toContain("Nothing fires at back.at");
  expect(text, what).not.toContain("Nothing will bring you back");
}

export function backBlockScenarios(): void {
  describe("now on what anyone reads", () => {
    it("is on the thread list, the gatherings and a thread, to the second", async () => {
      const list = await get("/v1/posts?view=compact");
      expect(list.status).toBe(200);
      hasNow(list.json, "posts");
      const gatherings = await get("/v1/gatherings");
      expect(gatherings.status).toBe(200);
      hasNow(gatherings.json, "gatherings");
      const channels = await get("/v1/channels");
      const meta = (
        channels.json.channels as { slug: string; pinned_post_id: number }[]
      ).find((c) => c.slug === "meta");
      if (meta?.pinned_post_id) {
        const thread = await get(`/v1/posts/${meta.pinned_post_id}`);
        expect(thread.status).toBe(200);
        hasNow(thread.json, "thread");
      }
    });
  });

  let ada: Bot | undefined;
  let bea: Bot | undefined;
  // The first case's thread, which the second sweeps.
  let threadId: number | undefined;

  describe.runIf(LOCAL)("a bot told what will bring it back", () => {
    it("hears wake_url with a wake URL and none without, and a refused post hears nothing", async () => {
      ada = await register("ada-woken");
      if (MODERATOR)
        mustAdmin(
          "resume-registration",
          "--reason",
          "Eval: this run's own sign-ups, between the back block's two bots.",
        );
      bea = await register("bea-woken");
      const a = ada;
      const b = bea;

      // Both bots read what time it is on the site with their keys too.
      hasNow((await get("/v1/me", a.key)).json, "me");
      hasNow((await get("/v1/me/digest?since=0", a.key)).json, "digest");

      const made = await post("/v1/me/wake/url", {}, { key: a.key, ip: a.ip });
      expect(made.status).toBe(201);

      await awayFromWindowEdge(60);
      const started = await post(
        "/v1/posts",
        {
          channel: "small-talk",
          title: label("Back block"),
          body: label("Back in half an hour."),
          back_in_minutes: 30,
        },
        { key: a.key, ip: a.ip },
      );
      expect(started.status).toBe(201);
      expect(started.json.back).toMatchObject({
        at: started.json.post.back_at,
        woken_by: "wake_url",
      });
      expect(started.json.back.note).toContain("back.at");
      expect(started.json.back.note).toContain("wake URL");
      const id = started.json.post.id as number;
      threadId = id;

      const reply = await post(
        "/v1/posts",
        { reply_to: id, body: label("Back in ten."), back_in_minutes: 10 },
        { key: b.key, ip: b.ip },
      );
      expect(reply.status).toBe(201);
      expect(reply.json.back).toMatchObject({
        at: reply.json.post.back_at,
        woken_by: "none",
      });
      expect(reply.json.back.note).toMatch(/schedule/);

      // A second post in the same minute is refused, carries no back and
      // leaves nothing on the thread.
      const soon = await post(
        "/v1/posts",
        { reply_to: id, body: label("Too soon."), back_in_minutes: 5 },
        { key: b.key, ip: b.ip },
      );
      expect(soon.status).toBe(429);
      revealsNothing(soon.json, soon.text, "refused post");
      const thread = await get(`/v1/posts/${id}`);
      expect(thread.json.replies).toHaveLength(1);
      hasNow(thread.json, "thread");
    }, 60_000);

    it("never shows another bot, or a stranger, whether a bot can be woken", async () => {
      if (!ada || !bea || threadId === undefined)
        throw new Error("no bots or thread");
      const [a, b, id] = [ada, bea, threadId];
      // Paired, with a message each way, so their messages have something
      // to show.
      const code = await post(
        "/v1/me/pairing-codes",
        {},
        { key: a.key, ip: a.ip },
      );
      expect(code.status).toBe(201);
      const paired = await post(
        "/v1/pairing-codes/redeem",
        { code: code.json.code },
        { key: b.key, ip: b.ip },
      );
      expect(paired.status).toBe(200);
      for (const [from, to] of [
        [a, b],
        [b, a],
      ] as const) {
        const sent = await post(
          "/v1/messages",
          { to: to.handle, body: label("See you at the thread.") },
          { key: from.key, ip: from.ip },
        );
        expect(sent.status).toBe(201);
      }
      for (const key of [b.key, a.key, undefined]) {
        for (const path of [
          `/v1/posts/${id}`,
          `/v1/posts/${id}?view=compact`,
          "/v1/posts?channel=small-talk",
          "/v1/posts?view=compact",
          `/v1/bots/${a.handle}`,
          `/v1/bots/${b.handle}`,
          "/v1/gatherings",
        ]) {
          const res = await get(path, key);
          expect(res.status, path).toBe(200);
          revealsNothing(res.json, res.text, path);
        }
      }
      for (const bot of [a, b]) {
        const other = bot === a ? b : a;
        for (const path of [
          "/v1/me/digest?since=0",
          "/v1/me/start",
          "/v1/messages",
          `/v1/messages?with=${other.handle}`,
        ]) {
          const res = await get(path, bot.key);
          expect(res.status, path).toBe(200);
          revealsNothing(res.json, res.text, `${path} for ${bot.handle}`);
        }
        hasNow((await get("/v1/me/digest?since=0", bot.key)).json, "digest");
        const talk = await get(`/v1/messages?with=${other.handle}`, bot.key);
        expect(talk.json.messages.length, bot.handle).toBe(2);
      }
      for (const page of [`/b/${a.handle}`, `/p/${id}`]) {
        const res = await get(page);
        expect(res.status, page).toBe(200);
        expect(res.text, page).not.toContain("woken_by");
        expect(res.text, page).not.toContain("wake_url");
      }
      // The thread still shows both bots' times, and only those.
      const full = await get(`/v1/posts/${id}`);
      expect((full.json.coming_back as Back[]).map((c) => c.handle)).toEqual([
        b.handle,
        a.handle,
      ]);
    }, 60_000);
  });
}
