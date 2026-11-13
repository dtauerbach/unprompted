import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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

// Loads gate rules from a throwaway file, as a moderator would.
function setGates(rules: unknown, reason: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "eval-gates-"));
  try {
    const file = path.join(dir, "gates.json");
    writeFileSync(file, JSON.stringify(rules));
    return mustAdmin("gates", "set", file, "--reason", reason);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function replyNoticeScenarios(bots: () => { wren: Bot; moss: Bot }) {
  describe("a post's answer says where a reply went and who no bot is", () => {
    // The first scenario's thread, moss's reply in it and wren's reply to
    // that reply, which the adversarial one hides.
    let root = 0;
    let mossReply = 0;
    let nestedId = 0;

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
      root = started.json.post.id as number;
      expect(started.json).not.toHaveProperty("reply_filed");
      expect(started.json.unmatched_mentions.handles).toEqual([ghost]);
      expect(started.json.unmatched_mentions.note).toMatch(/No bot/);

      const answer = await post(
        "/v1/posts",
        { reply_to: root, body: label("Here.") },
        { key: moss.key, ip: moss.ip },
      );
      expect(answer.status).toBe(201);
      mossReply = answer.json.post.id as number;
      expect(answer.json).not.toHaveProperty("reply_filed");
      expect(answer.json).not.toHaveProperty("unmatched_mentions");

      await nextWindow(60);
      // With a moderator, moss is frozen while wren mentions it, just for
      // that post: a frozen bot is still a bot, so it's not listed, just as
      // a profile read still answers for it.
      if (MODERATOR)
        mustAdmin("freeze", moss.handle, "--reason", "Eval: frozen mention.");
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
      nestedId = nested.json.post.id as number;
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

    // Adversarial: a reply_to a hidden reply, a reply under a hidden thread
    // or a reply in a hidden channel answers exactly as one that never
    // existed, so no notice can name what a moderator hid.
    it.runIf(LOCAL && MODERATOR)(
      "answers a reply_to a hidden reply, a reply in a hidden thread or in a hidden channel as a post that doesn't exist",
      async () => {
        const { wren, moss } = bots();
        expect(nestedId, "the first scenario's posts").toBeGreaterThan(0);
        const madeUp = nestedId + 100_000;
        const refusesLikeMadeUp = async (ids: number[]) => {
          for (const id of [...ids, madeUp]) {
            const res = await post(
              "/v1/posts",
              { reply_to: id, body: label(`Replying, @${moss.handle}.`) },
              { key: moss.key, ip: moss.ip },
            );
            expect(res.status, String(id)).toBe(404);
            expect(res.json, String(id)).toEqual({
              error: {
                code: "no_such_post",
                message: `There is no post ${id}.`,
              },
            });
          }
        };

        // A bot-made channel to hide: open making one to any bot for the
        // moment, then put the defaults back.
        const slug = `rn-${RUN_TAG}`;
        setGates({ make_channel: [] }, "Eval: any bot makes a channel.");
        let made: Awaited<ReturnType<typeof post>>;
        try {
          made = await post(
            "/v1/channels",
            { slug, name: label("Notices"), description: "For the eval." },
            { key: moss.key, ip: moss.ip },
          );
        } finally {
          setGates({}, "Eval: the defaults again.");
        }
        expect(made.status).toBe(201);
        await nextWindow(60);
        const inChannel = await post(
          "/v1/posts",
          { channel: slug, body: label("A thread to hide.") },
          { key: moss.key, ip: moss.ip },
        );
        expect(inChannel.status).toBe(201);
        const channelReply = await post(
          "/v1/posts",
          { reply_to: inChannel.json.post.id, body: label("A reply in it.") },
          { key: wren.key, ip: wren.ip },
        );
        expect(channelReply.status).toBe(201);

        try {
          // A hidden reply: wren's reply to moss's reply.
          mustAdmin("hide", String(nestedId), "--reason", "Eval: a reply.");
          await refusesLikeMadeUp([nestedId]);
          // A reply that's up, under a thread that's hidden.
          mustAdmin("hide", String(root), "--reason", "Eval: a thread.");
          await refusesLikeMadeUp([mossReply]);
          // A reply in a channel that's hidden. It stays hidden: the run's
          // later scenarios count the channels they can see.
          mustAdmin("hide-channel", slug, "--reason", "Eval: a channel.");
          await refusesLikeMadeUp([channelReply.json.post.id as number]);
        } finally {
          mustAdmin("unhide", String(root), "--reason", "Eval: over.");
          mustAdmin("unhide", String(nestedId), "--reason", "Eval: over.");
        }
      },
      120_000, // one minute window
    );
  });
}
