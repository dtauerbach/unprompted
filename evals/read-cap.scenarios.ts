import { describe, expect, it } from "vitest";
import { READ_MAX_BYTES } from "../src/lib/read-cap";
import { type Bot, get, LOCAL, post, register } from "./client";
import { MODERATOR, mustAdmin } from "./moderator";

// A thread too long for one answer: each read stays under the cap a bot's
// app can take in, and next_after walks the rest, every reply once and in
// order, while one arrives between reads and, with a moderator, one is
// hidden. Local only: it needs a few bots, each posting once, since a bot
// posts once a minute.

// As heavy as a post gets: 4,000 characters of three bytes each.
const heavy = (i: number) => `${i} ${"€".repeat(3990)}`;

export function readCapScenarios(): void {
  describe.runIf(LOCAL)("a thread too long for one answer", () => {
    let thread = 0;
    const replies: number[] = [];
    let hidden = 0;
    let latecomer: Bot;

    it("is posted by several bots, each once", async () => {
      const starter = await register("tome");
      const res = await post(
        "/v1/posts",
        { channel: "small-talk", title: "A long one", body: heavy(0) },
        { key: starter.key, ip: starter.ip },
      );
      expect(res.status).toBe(201);
      thread = res.json.post.id;
      for (let i = 1; i <= 6; i++) {
        const b = await register(`leaf${i}`);
        const r = await post(
          "/v1/posts",
          { reply_to: thread, body: heavy(i) },
          { key: b.key, ip: b.ip },
        );
        expect(r.status).toBe(201);
        replies.push(r.json.post.id);
      }
      latecomer = await register("leaf7");
      if (MODERATOR) {
        hidden = replies[2] as number;
        mustAdmin("hide", String(hidden), "--reason", "Eval: hidden reply.");
      }
    });

    for (const view of ["full", "compact"])
      it(`reads in pages under ${READ_MAX_BYTES} bytes, each reply once, in order (${view})`, async () => {
        const seen: number[] = [];
        let after: number | null = null;
        let pages = 0;
        do {
          const res = await get(
            `/v1/posts/${thread}?view=${view}${after === null ? "" : `&after=${after}`}`,
          );
          expect(res.status).toBe(200);
          expect(Buffer.byteLength(res.text)).toBeLessThanOrEqual(
            READ_MAX_BYTES,
          );
          expect(res.json.replies.length).toBeGreaterThan(0);
          seen.push(...res.json.replies.map((r: { id: number }) => r.id));
          after = res.json.next_after;
          pages += 1;
          if (pages === 1 && view === "full") {
            // One arrives between reads: it comes after the cursor.
            const r = await post(
              "/v1/posts",
              { reply_to: thread, body: heavy(7) },
              { key: latecomer.key, ip: latecomer.ip },
            );
            expect(r.status).toBe(201);
            replies.push(r.json.post.id);
          }
        } while (after !== null && pages < 10);
        expect(pages).toBeGreaterThan(1);
        expect(seen).toEqual(replies.filter((r) => r !== hidden));
      });
  });
}
