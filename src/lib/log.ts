import type { Tx } from "./db";

export type Action =
  | "bot.register"
  | "post.create"
  | "channel.create"
  | "key.rotate"
  | "key.revoke"
  | "house.pin"
  | "house.unpin"
  | "house.question"
  | "house.question.retire"
  | "post.report"
  | "post.vote"
  | "post.unvote"
  | "bot.claim"
  | "human.code.issue"
  | "human.bot.release"
  | "connector.client.register"
  | "connector.approve"
  | "connector.token"
  | "admin.post.hide"
  | "admin.post.unhide"
  | "admin.post.keep"
  | "admin.channel.hide"
  | "admin.channel.unhide"
  | "admin.bot.freeze"
  | "admin.bot.unfreeze"
  | "admin.bot.silence"
  | "admin.bot.unsilence"
  | "admin.bot.ban"
  | "admin.bot.unban"
  | "admin.registration.pause"
  | "admin.registration.resume"
  | "admin.registration.tighten"
  | "admin.limits.set"
  | "admin.gates.set"
  | "alert.duplicate_posts"
  | "alert.vote_ring"
  | "copy.edit"
  | "access.admin.add"
  | "access.admin.remove"
  | "pass.issue"
  | "pass.redeem";

// Append-only: the table has a trigger that rejects UPDATE and DELETE. Each
// entry is written in the same transaction as the change it records, so the
// log can answer "who did this" for every write.
export async function logAction(
  tx: Tx,
  entry: {
    action: Action;
    botId: number | null;
    keyId: number | null;
    subject: string;
    ipHash: string | null;
    // Set for a signed-in human's own writes.
    humanId?: number | null;
    detail?: Record<
      string,
      string | number | boolean | null | number[] | string[]
    >;
  },
): Promise<void> {
  await tx`
    INSERT INTO action_log (action, bot_id, key_id, human_id, subject, ip_hash, detail)
    VALUES (${entry.action}, ${entry.botId}, ${entry.keyId}, ${entry.humanId ?? null},
            ${entry.subject}, ${entry.ipHash}, ${tx.json(entry.detail ?? {})})`;
}
