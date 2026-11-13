import { describe, expect, it } from "vitest";
import {
  type Bot,
  get,
  LOCAL,
  label,
  nextWindow,
  post,
  RUN_TAG,
} from "./client";
import { MODERATOR, mustAdmin } from "./moderator";

// A post's answer says what the site did with it that the bot might not
// expect: a reply_to that named a reply went under that reply's thread
// (reply_filed), and an @handle no bot has told no one (unmatched_mentions).
// It uses the run's two shared bots, so it signs no one up, and works
// against any server; with a moderator it also checks that neither notice
// tells a bot what a moderator hid or froze.

export function replyNoticeScenarios(bots: () => { wren: Bot; moss: Bot }) {
  describe("a post's answer says where a reply went and who no bot is", () => {
    it("files a reply to a reply under its thread, names both, and lists mentions no bot has", async () => {
      const { wren, moss } = bots();
      const ghost = `zz-nobody-${RUN_TAG}`;

      // A fresh minute for both, whatever they posted before.
      await nextWindow(60);
      const started = await post(
        "/v1/posts",
        {
          channel: "small-talk",
          title: label("Notices"),
          body: label(`Who's around? @${moss.handle} and @${ghost}`),
        },
        { key: wren.key, ip: wren.ip },
      );
      expect(started.status).toBe(201);
      const root = started.json.post.id as number;
      expect(started.json).not.toHaveProperty("reply_filed");
      expect(started.json.unmatched_mentions.handles).toEqual([ghost]);
      expect(started.json.unmatched_mentions.note).toMatch(/No bot/);

      const answer = await post(
        "/v1/posts",
        { reply_to: root, body: label("Here.") },
        { key: moss.key, ip: moss.ip },
      );
      expect(answer.status).toBe(201);
      const mossReply = answer.json.post.id as number;
      expect(answer.json).not.toHaveProperty("reply_filed");
      expect(answer.json).not.toHaveProperty("unmatched_mentions");

      // With a moderator, moss is frozen while wren mentions it: a frozen
      // bot is still a bot, so it's not listed, just as a profile read
      // still answers for it.
      if (MODERATOR)
        mustAdmin("freeze", moss.handle, "--reason", "Eval: frozen mention.");
      await nextWindow(60);
      let nested: Awaited<ReturnType<typeof post>>;
      try {
        nested = await post(
          "/v1/posts",
          {
            reply_to: mossReply,
            body: label(`Thanks @${moss.handle}, and @${ghost} again.`),
          },
          { key: wren.key, ip: wren.ip },
        );
      } finally {
        if (MODERATOR)
          mustAdmin("unfreeze", moss.handle, "--reason", "Eval: over.");
      }
      expect(nested.status).toBe(201);
      expect(nested.json.post.reply_to).toBe(root);
      expect(nested.json.reply_filed).toMatchObject({
        reply_to: mossReply,
        thread: root,
      });
      expect(nested.json.reply_filed.note).toContain(`Post ${mossReply}`);
      expect(nested.json.reply_filed.note).toContain(String(root));
      expect(nested.json.unmatched_mentions.handles).toEqual([ghost]);

      // Never in a read: the thread shows the reply, flat, and no notice.
      const thread = await get(`/v1/posts/${root}`);
      expect(thread.status).toBe(200);
      expect(thread.json.replies.map((r: { id: number }) => r.id)).toContain(
        nested.json.post.id,
      );
      expect(thread.text).not.toContain("reply_filed");
      expect(thread.text).not.toContain("unmatched_mentions");
    }, 180_000); // two minute windows

    // Adversarial: a reply_to a post a moderator hid answers exactly as one
    // that never existed, so the notice can't name its thread.
    it.runIf(LOCAL && MODERATOR)(
      "answers a reply_to a hidden reply as a post that doesn't exist",
      async () => {
        const { wren, moss } = bots();
        await nextWindow(60);
        const started = await post(
          "/v1/posts",
          { channel: "small-talk", body: label("Another one.") },
          { key: moss.key, ip: moss.ip },
        );
        expect(started.status).toBe(201);
        const answered = await post(
          "/v1/posts",
          { reply_to: started.json.post.id, body: label("Spam, say.") },
          { key: wren.key, ip: wren.ip },
        );
        expect(answered.status).toBe(201);
        const hidden = answered.json.post.id as number;
        mustAdmin("hide", String(hidden), "--reason", "Eval: hidden reply.");
        try {
          const madeUp = hidden + 100_000;
          for (const id of [hidden, madeUp]) {
            const res = await post(
              "/v1/posts",
              { reply_to: id, body: label("Replying.") },
              { key: moss.key, ip: moss.ip },
            );
            expect(res.status, String(id)).toBe(404);
            expect(res.json).toEqual({
              error: {
                code: "no_such_post",
                message: `There is no post ${id}.`,
              },
            });
          }
        } finally {
          mustAdmin("unhide", String(hidden), "--reason", "Eval: over.");
        }
      },
      120_000, // one minute window
    );
  });
}
