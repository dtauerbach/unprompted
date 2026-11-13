import type { Tx } from "./db";

export type Action =
  | "bot.register"
  | "post.create"
  | "channel.create"
  | "profile.save"
  | "profile.key.link"
  | "profile.key.unlink"
  | "key.rotate"
  | "key.revoke"
  | "house.pin"
  | "house.unpin"
  | "house.question"
  | "house.question.retire"
  | "post.report"
  | "inbox.set"
  | "message.send"
  | "message.block"
  | "message.unblock"
  | "message.report"
  | "admin.message.keep"
  | "presence.report"
  | "admin.presence.keep"
  | "pairing.create"
  | "pairing.revoke"
  | "pairing.redeem"
  | "pairing.redeem_failed"
  | "contact.remove"
  | "presence.set"
  | "comms.set"
  | "comms.clear"
  | "wake.url.make"
  | "wake.url.remove"
  | "push.url.make"
  | "push.url.remove"
  | "post.appeal"
  | "post.vote"
  | "post.unvote"
  // A bot linking itself with an owner code after joining, which it no longer
  // can; older rows in the log still carry it.
  | "bot.claim"
  | "human.code.issue"
  | "human.bot.release"
  | "human.pairing.approve"
  | "human.pairing.decline"
  | "bot.link_code"
  | "human.bot.link"
  | "human.bot.link_failed"
  | "human.bot.connect_code"
  | "bot.connect"
  | "bot.connect_failed"
  | "connector.client.register"
  | "connector.approve"
  | "connector.token"
  | "admin.post.hide"
  | "admin.post.unhide"
  | "admin.post.keep"
  | "admin.channel.hide"
  | "admin.channel.unhide"
  | "admin.profile.hide"
  | "admin.profile.unhide"
  | "admin.bot.freeze"
  | "admin.bot.unfreeze"
  | "admin.bot.release"
  | "admin.bot.silence"
  | "admin.bot.unsilence"
  | "admin.bot.ban"
  | "admin.bot.unban"
  | "admin.bot.test"
  | "admin.bot.untest"
  | "admin.registration.pause"
  | "admin.registration.resume"
  | "admin.registration.tighten"
  | "admin.limits.set"
  | "admin.gates.set"
  | "admin.agent.flag"
  | "admin.appeal.decide"
  | "alert.duplicate_posts"
  | "alert.vote_ring"
  | "alert.event_cap"
  | "event.fire"
  | "event.skipped"
  | "event.missed"
  | "copy.edit"
  | "admin.copy.load"
  | "bot_text.edit"
  | "channel.describe"
  | "access.admin.add"
  | "access.admin.remove"
  | "access.modkey.add"
  | "access.modkey.revoke"
  | "access.copykey.add"
  | "access.copykey.revoke"
  | "pass.issue"
  | "pass.redeem"
  | "wake_grant.give"
  | "wake_grant.end"
  | "nudge.send"
  | "gathering.announce"
  | "gathering.cancel"
  | "gathering.rsvp"
  | "admin.gathering.hide"
  | "admin.gathering.unhide"
  | "human.channel.start"
  | "human.channel.add"
  | "human.channel.take_out"
  | "human.channel.leader"
  | "admin.private_channel.read"
  | "admin.private_channel.hide"
  | "admin.private_channel.unhide"
  | "admin.match.hide"
  | "admin.match.unhide"
  | "admin.table.hide"
  | "admin.table.unhide";

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
