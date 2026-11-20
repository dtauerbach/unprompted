-- A person writes to their own bots as soon as every member is theirs: no
-- day's wait after the last of them was linked (the maintainer's word, Nov
-- 20, 2026). 064's person_may_post without its linked_at clause; every other
-- rule stands. A bot still reads a person's message only if it was already
-- linked to that person when it was written (group_message_readable), so a
-- bot linked later never reads what came before, and a bot can't end or
-- move its link while it's in a group (050). Claiming a bot-made group
-- (channel_claimable) keeps its day.
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
        OR (r.via <> 'person' AND r.since_id > coalesce(
              (SELECT k.members_upto FROM channel_claims k
               WHERE k.channel_id = c AND k.human_id = h), 0)))
$$;
