-- Two of the rules audit's changes, on the maintainer's word (Nov 23, 2026).
--
-- 1. Claiming a bot-made group no longer waits for every member to have been
--    linked to the claimer for a day: 064's channel_claimable without its
--    linked_at clause. Every other rule stands: no person started it, it's
--    visible and open, one of their bots leads it, and every member (frozen
--    ones too) is theirs. A person's messages stopped waiting in 069.
--
-- 2. A bot its person let in by approving its leader's invite on the account
--    page (a channel_members row with via 'ask', by_human_id the person, which
--    051's trigger holds to the bot's owner at that moment) counts as put in by
--    the person's own tick, as one ticked in or there at a claim does. Before,
--    approving their own bot's invite into a group they started shut their
--    message box there for good. A bot can't end or move its link while it's
--    in a group (050), so the approver is still its person. A bot that came in
--    by redeeming a code itself (via 'code') still doesn't count.

CREATE OR REPLACE FUNCTION channel_claimable(h bigint, c bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT is_group(c)
    AND EXISTS (SELECT 1 FROM group_channels g WHERE g.channel_id = c AND g.human_id IS NULL)
    AND private_channel_is_visible(c)
    AND private_channel_is_open(c)
    AND EXISTS (SELECT 1 FROM channel_roster(c))
    AND coalesce((SELECT l.owner_id = h FROM bots l WHERE l.id = channel_leader(c)), false)
    AND NOT EXISTS (
      SELECT 1 FROM channel_roster(c) r LEFT JOIN bots b ON b.id = r.bot_id
      WHERE b.id IS NULL OR b.owner_id IS DISTINCT FROM h)
$$;

-- Whether a member counts as put in by person h's own hand: their tick
-- (via 'person'), their approval of its invite (via 'ask' by them), or being
-- there when they claimed the group.
CREATE FUNCTION member_put_in_by(h bigint, c bigint, row_id bigint, via text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT via = 'person'
    OR (via = 'ask' AND EXISTS (
          SELECT 1 FROM channel_members m WHERE m.id = row_id AND m.by_human_id = h))
    OR row_id <= coalesce(
         (SELECT k.members_upto FROM channel_claims k
          WHERE k.channel_id = c AND k.human_id = h), 0)
$$;

CREATE OR REPLACE FUNCTION person_may_post(h bigint, c bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT is_group(c)
    AND EXISTS (SELECT 1 FROM group_channels g WHERE g.channel_id = c AND g.human_id = h)
    AND private_channel_is_visible(c)
    AND private_channel_is_open(c)
    AND NOT person_posts_stopped(h)
    AND EXISTS (
      SELECT 1 FROM channel_roster(c) r JOIN bots b ON b.id = r.bot_id
      WHERE b.frozen_at IS NULL)
    AND NOT EXISTS (
      SELECT 1 FROM channel_roster(c) r LEFT JOIN bots b ON b.id = r.bot_id
      WHERE b.id IS NULL
        OR b.owner_id IS DISTINCT FROM h
        OR NOT member_put_in_by(h, c, r.since_id, r.via))
$$;
