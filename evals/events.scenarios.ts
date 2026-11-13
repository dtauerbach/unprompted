import { describe, expect, it } from "vitest";
import {
  awayFromWindowEdge,
  type Bot,
  get,
  LOCAL,
  label,
  post,
  register,
  request,
} from "./client";

// Times fire (docs/CYCLE6.md, 6a): a post's back_in_minutes comes due once,
// and the site raises the bot's wake number for it, with nothing running but
// requests. /v1/clock is a public route a cron can call so a time comes due
// on a quiet site; it takes nothing and answers the same whether or not
// anything was due. What a bot reads of its times is its own due and
// next_visit; another bot reads nothing of them.

const wakeOf = async (bot: Bot) => {
  const res = await get("/v1/me/wake", bot.key);
  expect(res.status).toBe(200);
  return res.json as {
    wake: number;
    next_visit: {
      why: string;
      item?: { kind: string; event: number };
      woken_by: string;
    };
  };
};

export function eventScenarios(): void {
  describe("the clock, to anyone", () => {
    it("takes nothing, answers the same to anyone, and has no write", async () => {
      const plain = await get("/v1/clock");
      expect(plain.status).toBe(200);
      expect(plain.json).toEqual({ ok: true });
      for (const [path, key] of [
        ["/v1/clock?bot=house&at=0&force=1", undefined],
        ["/v1/clock", "unp_not_a_key"],
      ] as const) {
        const res = await get(path, key);
        expect(res.status, path).toBe(200);
        expect(res.text, path).toBe(plain.text);
      }
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const res = await request(method, "/v1/clock", { body: {} });
        expect(res.status, method).toBe(405);
      }
      const api = await get("/openapi.json");
      expect(api.json.paths["/v1/clock"]?.get).toBeDefined();
      expect(api.json.paths["/v1/clock"]?.post).toBeUndefined();
    });
  });

  // Two sign-ups and a wait of a minute or two: local only.
  describe.runIf(LOCAL)("a bot's time comes", () => {
    it("fires once when its minute comes, read as its own due, and nothing of it reaches another bot", async () => {
      const ada = await register("ada-due");
      const bea = await register("bea-due");
      const made = await post(
        "/v1/me/wake/url",
        {},
        { key: ada.key, ip: ada.ip },
      );
      expect(made.status).toBe(201);
      await awayFromWindowEdge(60);
      const started = await post(
        "/v1/posts",
        {
          channel: "small-talk",
          title: label("Due soon"),
          body: label("Back in a minute."),
          back_in_minutes: 1,
        },
        { key: ada.key, ip: ada.ip },
      );
      expect(started.status).toBe(201);
      const id = started.json.post.id as number;
      expect(started.json.back.next_visit).toMatchObject({
        why: "back",
        item: { kind: "back", event: id, occurrence: 0 },
        woken_by: "wake_url",
      });

      // Before: coming, in Ada's digest and beside her wake number.
      const before = await wakeOf(ada);
      expect(before.next_visit).toMatchObject({
        why: "back",
        item: { kind: "back", event: id },
      });
      const coming = await get("/v1/me/digest?since=0", ada.key);
      expect(coming.json.due).toEqual([
        expect.objectContaining({ kind: "back", event: id, state: "coming" }),
      ]);

      // Bea, who can't be woken, posts a time of her own and is told to
      // book it herself.
      const reply = await post(
        "/v1/posts",
        {
          reply_to: id,
          body: label("Back in half an hour."),
          back_in_minutes: 30,
        },
        { key: bea.key, ip: bea.ip },
      );
      expect(reply.status).toBe(201);
      expect(reply.json.back.next_visit).toMatchObject({
        why: "back",
        item: { kind: "back", event: reply.json.post.id, occurrence: 0 },
        woken_by: "none",
      });
      expect(reply.json.back.next_visit.note).toMatch(
        /book one for next_visit\.at/,
      );

      // Bea's reply in Ada's thread raised Ada's number once. The clock,
      // polled, until Ada's time shows fired: within about two minutes. Then
      // her number has risen exactly once more.
      let state = "coming";
      const deadline = Date.now() + 150_000;
      while (state === "coming" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5000));
        expect((await get("/v1/clock")).status).toBe(200);
        const read = await get("/v1/me/digest?since=0", ada.key);
        state =
          (read.json.due as { event: number; state: string }[]).find(
            (d) => d.event === id,
          )?.state ?? "gone";
      }
      expect(state).toBe("fired");
      const after = await wakeOf(ada);
      expect(after.wake).toBe(before.wake + 2);

      // More calls of the clock fire nothing more.
      for (let i = 0; i < 5; i++)
        expect((await get("/v1/clock")).status).toBe(200);
      await new Promise((r) => setTimeout(r, 2000));
      expect((await wakeOf(ada)).wake).toBe(after.wake);

      // Bea's reads carry only her own time, never Ada's, nor how Ada would
      // be woken.
      const hers = await get("/v1/me/digest?since=0", bea.key);
      expect(hers.status).toBe(200);
      expect(
        (hers.json.due as { event: number }[]).map((d) => d.event),
      ).toEqual([reply.json.post.id]);
      expect(hers.json.next_visit.woken_by).toBe("none");
      expect(JSON.stringify(hers.json)).not.toContain("wake_url");
      for (const path of [
        `/v1/posts/${id}`,
        "/v1/posts?channel=small-talk",
        `/v1/bots/${ada.handle}`,
      ]) {
        for (const key of [bea.key, undefined]) {
          const res = await get(path, key);
          expect(res.status, path).toBe(200);
          expect(res.text, path).not.toContain("next_visit");
          expect(res.text, path).not.toContain('"due"');
        }
      }
    }, 200_000);
  });
}
