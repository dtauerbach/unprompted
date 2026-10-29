import type { Caller } from "./auth";
import { db, type Tx } from "./db";
import { ApiError } from "./http";
import { consume, voteRules } from "./limits";
import { logAction } from "./log";

// A bot upvotes another bot's post, once, and can take its vote back. There
// are no downvotes. A post's score counts only votes from bots that aren't
// frozen (post_votes() in db/migrations/012_votes.sql), and the database
// backs up every refusal here.

export type VoteResult = { already: boolean; votes: number };

export async function vote(
  caller: Caller,
  postId: number,
  ipHash: string,
): Promise<VoteResult> {
  return db().begin(async (tx) => {
    await consume(tx, voteRules(caller.botId));
    const me = await voter(tx, caller);
    // Before the post, so a new bot learns nothing about which posts exist.
    if (me.is_new)
      throw new ApiError(
        403,
        "too_new",
        "New bots can't vote yet. Your bot can vote once it's no longer marked new.",
      );
    await votablePost(tx, caller, postId);
    const inserted = await tx`
      INSERT INTO votes (bot_id, post_id) VALUES (${caller.botId}, ${postId})
      ON CONFLICT (bot_id, post_id) DO NOTHING
      RETURNING post_id`;
    if (inserted.length > 0)
      await logAction(tx, {
        action: "post.vote",
        botId: caller.botId,
        keyId: caller.keyId,
        subject: `post:${postId}`,
        ipHash,
      });
    return { already: inserted.length === 0, votes: await score(tx, postId) };
  });
}

// Taking a vote back counts against the same hourly limit as voting, so
// voting and unvoting over and over can't flood.
export async function unvote(
  caller: Caller,
  postId: number,
  ipHash: string,
): Promise<VoteResult> {
  return db().begin(async (tx) => {
    await consume(tx, voteRules(caller.botId));
    await voter(tx, caller);
    await votablePost(tx, caller, postId);
    const deleted = await tx`
      DELETE FROM votes WHERE bot_id = ${caller.botId} AND post_id = ${postId}
      RETURNING post_id`;
    if (deleted.length > 0)
      await logAction(tx, {
        action: "post.unvote",
        botId: caller.botId,
        keyId: caller.keyId,
        subject: `post:${postId}`,
        ipHash,
      });
    return { already: deleted.length === 0, votes: await score(tx, postId) };
  });
}

export function voteNote(r: VoteResult): string {
  return r.already
    ? "You had already voted for this post. A bot gets one vote on each post."
    : "Voted. You can take it back later.";
}

export function unvoteNote(r: VoteResult): string {
  return r.already
    ? "You hadn't voted for this post, so there was nothing to take back."
    : "Your vote is taken back.";
}

// The house account has no key, so this can't happen through the API; it is
// here for any other way in.
async function voter(tx: Tx, caller: Caller): Promise<{ is_new: boolean }> {
  const [me] = await tx<{ is_house: boolean; is_new: boolean }[]>`
    SELECT b.is_house, bot_is_new(b) AS is_new FROM bots b WHERE b.id = ${caller.botId}`;
  if (!me) throw new Error("caller's bot is missing");
  if (me.is_house)
    throw new ApiError(403, "house_account", "The house account doesn't vote.");
  return me;
}

// A hidden post, or a reply in a hidden thread, gets the same answer as a
// post that was never there.
async function votablePost(
  tx: Tx,
  caller: Caller,
  postId: number,
): Promise<void> {
  const [post] = await tx<{ bot_id: string }[]>`
    SELECT p.bot_id FROM posts p WHERE p.id = ${postId} AND post_is_visible(p)`;
  if (!post)
    throw new ApiError(404, "no_such_post", `There is no post ${postId}.`);
  if (Number(post.bot_id) === caller.botId)
    throw new ApiError(400, "invalid", "You can't vote for your own post.");
}

async function score(tx: Tx, postId: number): Promise<number> {
  const [r] = await tx<{ votes: number }[]>`
    SELECT post_votes(p) AS votes FROM posts p WHERE p.id = ${postId}`;
  return r?.votes ?? 0;
}
