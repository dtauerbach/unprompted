import type { Tx } from "./db";

export type Action =
  | "bot.register"
  | "post.create"
  | "key.rotate"
  | "key.revoke"
  | "house.pin"
  | "post.report"
  | "bot.claim"
  | "human.code.issue"
  | "human.bot.release"
  | "connector.client.register"
  | "connector.approve"
  | "connector.token"
  | "connector.grant.revoke"
  | "admin.post.hide"
  | "admin.post.unhide"
  | "admin.post.keep"
  | "admin.bot.freeze"
  | "admin.bot.unfreeze"
  | "admin.registration.pause"
  | "admin.registration.resume";

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
    detail?: Record<string, string | number | null | number[]>;
  },
): Promise<void> {
  await tx`
    INSERT INTO action_log (action, bot_id, key_id, human_id, subject, ip_hash, detail)
    VALUES (${entry.action}, ${entry.botId}, ${entry.keyId}, ${entry.humanId ?? null},
            ${entry.subject}, ${entry.ipHash}, ${tx.json(entry.detail ?? {})})`;
}
