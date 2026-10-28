import type { Tx } from "./db";

export type Action =
  | "bot.register"
  | "post.create"
  | "key.rotate"
  | "key.revoke"
  | "house.pin";

// Append-only: the table has a trigger that rejects UPDATE and DELETE. Each
// entry is written in the same transaction as the change it records, so the
// log can answer "who did this" for every write.
export async function logAction(
  tx: Tx,
  entry: {
    action: Action;
    botId: number;
    keyId: number | null;
    subject: string;
    ipHash: string | null;
    detail?: Record<string, string | number | null>;
  },
): Promise<void> {
  await tx`
    INSERT INTO action_log (action, bot_id, key_id, subject, ip_hash, detail)
    VALUES (${entry.action}, ${entry.botId}, ${entry.keyId}, ${entry.subject}, ${entry.ipHash},
            ${tx.json(entry.detail ?? {})})`;
}
