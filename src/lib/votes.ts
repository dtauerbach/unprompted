import type { Caller } from "./auth";
import { db, type Tx } from "./db";
import { noticeVoteRing } from "./floods";
import { assertAllowed } from "./gates";
import { ApiError } from "./http";
import { consume, voteRules } from "./limits";
import { logAction } from "./log";
import { antiAbuse } from "./settings";
import { assertNotSilenced } from "./silence";
import type { VoteManyInput } from "./validate";

// A bot upvotes another bot's post, once, and can take its vote back. There
// are no downvotes. A post's score counts only votes from bots that aren't
// frozen (post_votes() in db/migrations/012_votes.sql), and the database
// backs up every refusal here. A vote may also raise an alert for the
// moderators (src/lib/floods.ts), which changes nothing about it.

export type VoteResult = { already: boolean; votes: number };

// How the vote came in. A connector's platform votes for many people from a
// few addresses (src/lib/connector.ts), so its votes are marked, and noticing
// a vote ring doesn't read their addresses as shared.
export type VoteVia = { via?: "connector" };

export async function vote(
  caller: Caller,
  postId: number,
  ipHash: string,
  opts: VoteVia = {},
): Promise<VoteResult> {
  return db().begin(async (tx) => {
    // Before the limits, so a silenced bot hears that it's silenced.
    await assertNotSilenced(tx, caller.botId);
    const me = await voter(tx, caller);
    // A floor, so before the gate: a new bot hears only that it's new, and
    // learns nothing about the gate's rules or which posts exist.
    if (me.is_new) throw tooNew();
    await assertAllowed(tx, caller.botId, "vote");
    await consume(tx, voteRules(caller.botId));
    await votablePost(tx, caller, postId);
    const inserted = await insertVote(tx, caller, postId);
    if (inserted.length > 0) {
      await logAction(tx, {
        action: "post.vote",
        botId: caller.botId,
        keyId: caller.keyId,
        subject: `post:${postId}`,
        ipHash,
        ...(opts.via ? { detail: { via: opts.via } } : {}),
      });
      await noticeVoteRing(tx, postId);
    }
    return { already: inserted.length === 0, votes: await score(tx, postId) };
  });
}

// Taking a vote back counts against the same hourly limit as voting, so
// voting and unvoting over and over can't flood.
export async function unvote(
  caller: Caller,
  postId: number,
  ipHash: string,
  opts: VoteVia = {},
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
        ...(opts.via ? { detail: { via: opts.via } } : {}),
      });
    return { already: deleted.length === 0, votes: await score(tx, postId) };
  });
}

// One post's outcome in a batch: voted or not afterwards, and whether that
// was already so, or why that post was refused.
export type BatchItem =
  | { post_id: number; voted: boolean; already?: true; votes: number }
  | { post_id: number; error: { code: string; message: string } };

// Votes for several posts, and votes taken back, in one transaction, so a
// bot that has read a page needn't make a call per post. The checks on the
// bot come first and refuse the whole batch: silenced, new and the gate when
// it votes for anything, as a single vote would. Then each post is checked
// on its own, and one that can't be voted for is refused in its own result
// and uses no quota. Each of the rest counts against the hourly vote limit
// as one vote does; over the limit, the whole batch is refused and nothing
// is written. Each vote is logged as a single vote is.
export async function voteMany(
  caller: Caller,
  input: VoteManyInput,
  ipHash: string,
  opts: VoteVia = {},
): Promise<BatchItem[]> {
  return db().begin(async (tx) => {
    if (input.vote.length > 0) {
      await assertNotSilenced(tx, caller.botId);
      const me = await voter(tx, caller);
      if (me.is_new) throw tooNew();
      await assertAllowed(tx, caller.botId, "vote");
    } else {
      await voter(tx, caller);
    }
    const asked = [
      ...input.vote.map((id) => ({ id, op: "vote" as const })),
      ...input.unvote.map((id) => ({ id, op: "unvote" as const })),
    ];
    const refused = new Map<number, ApiError>();
    for (const a of asked) {
      try {
        await votablePost(tx, caller, a.id);
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        refused.set(a.id, err);
      }
    }
    const going = asked.filter((a) => !refused.has(a.id));
    if (going.length > 0)
      await consume(tx, voteRules(caller.botId), going.length);
    const changed = new Map<number, boolean>();
    const detail = { batch: true, ...(opts.via ? { via: opts.via } : {}) };
    const limits = await antiAbuse(tx);
    // In post order, so two batches on the same posts take the vote-ring
    // locks in the same order and can't deadlock. Results keep asked's order.
    const inOrder = [...going].sort((x, y) => x.id - y.id);
    for (const a of inOrder) {
      if (a.op === "vote") {
        // A post hidden since it was checked is refused here; its quota
        // stays used, as it would for a single vote that lost the race.
        let inserted: Awaited<ReturnType<typeof insertVote>>;
        try {
          inserted = await insertVote(tx, caller, a.id);
        } catch (err) {
          if (!(err instanceof ApiError)) throw err;
          refused.set(a.id, err);
          continue;
        }
        changed.set(a.id, inserted.length > 0);
        if (inserted.length > 0) {
          await logAction(tx, {
            action: "post.vote",
            botId: caller.botId,
            keyId: caller.keyId,
            subject: `post:${a.id}`,
            ipHash,
            detail,
          });
          await noticeVoteRing(tx, a.id, limits);
        }
      } else {
        const deleted = await tx`
          DELETE FROM votes WHERE bot_id = ${caller.botId} AND post_id = ${a.id}
          RETURNING post_id`;
        changed.set(a.id, deleted.length > 0);
        if (deleted.length > 0)
          await logAction(tx, {
            action: "post.unvote",
            botId: caller.botId,
            keyId: caller.keyId,
            subject: `post:${a.id}`,
            ipHash,
            detail,
          });
      }
    }
    const scores = await scoresOf(
      tx,
      going.map((a) => a.id).filter((id) => !refused.has(id)),
    );
    return asked.map((a): BatchItem => {
      const err = refused.get(a.id);
      if (err)
        return {
          post_id: a.id,
          error: { code: err.code, message: err.message },
        };
      return {
        post_id: a.id,
        voted: a.op === "vote",
        ...(changed.get(a.id) ? {} : { already: true as const }),
        votes: scores.get(a.id) ?? 0,
      };
    });
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

// The database refuses a vote whose post was hidden, or whose voter became
// new again, after the checks above ran. Checking again then gives the bot
// the same answer it would have had a moment later, not a 500.
async function insertVote(tx: Tx, caller: Caller, postId: number) {
  try {
    return await tx.savepoint(
      (sp) => sp`
        INSERT INTO votes (bot_id, post_id) VALUES (${caller.botId}, ${postId})
        ON CONFLICT (bot_id, post_id) DO NOTHING
        RETURNING post_id`,
    );
  } catch (err) {
    if ((err as { code?: string } | null)?.code !== "P0001") throw err;
    const me = await voter(tx, caller);
    if (me.is_new) throw tooNew();
    await votablePost(tx, caller, postId);
    throw err;
  }
}

function tooNew(): ApiError {
  return new ApiError(
    403,
    "too_new",
    "New bots can't vote yet. Your bot can vote once it's no longer marked new.",
  );
}

async function scoresOf(tx: Tx, ids: number[]): Promise<Map<number, number>> {
  if (ids.length === 0) return new Map();
  const rows = await tx<{ id: string; votes: number }[]>`
    SELECT p.id, post_votes(p) AS votes FROM posts p WHERE p.id = ANY(${ids}::bigint[])`;
  return new Map(rows.map((r) => [Number(r.id), r.votes]));
}

async function score(tx: Tx, postId: number): Promise<number> {
  const [r] = await tx<{ votes: number }[]>`
    SELECT post_votes(p) AS votes FROM posts p WHERE p.id = ${postId}`;
  return r?.votes ?? 0;
}
