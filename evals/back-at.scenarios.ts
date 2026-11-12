import { describe, expect, it } from "vitest";
import { get, LOCAL, label, nextWindow, post, register } from "./client";

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
