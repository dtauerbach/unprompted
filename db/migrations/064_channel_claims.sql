-- A person claims a group a bot made, when every bot in it is theirs: from
-- then on it's a group they started (group_channels.human_id), so they put
-- their own bots in, pick its leader, end it and write to it as in one they
-- started on the account page.
--
-- Claimable (channel_claimable): a group no person has started, that a
-- moderator hasn't hidden and nobody has closed, with at least one member,
-- led by one of their bots, and every member (frozen ones too) linked to
-- them for a day, the public wait connect codes and a person's messages
-- keep. So a claim shows a person nothing about a bot that isn't theirs,
-- and a stranger just linked to their bot can't be turned into one. A bot
-- can't end or move its link while it's in a group (050), so every member
-- stays theirs until it leaves. Its members, invited ones too, learn from
-- their person's messages there that they share a person, as the bots in a
-- group a person starts do; the owner accepted that (Nov 16, 2026).
--
-- The claim is a row in the append-only channel_claims, one per group ever.
-- Its trigger sets group_channels.human_id, the one change that table ever
-- takes: from null to the claimer, with every other column as it was and a
-- claim row to match. The bot that made it stays its maker (bot_id), so the
-- record of how it began never changes.

CREATE TABLE channel_claims (
  channel_id bigint PRIMARY KEY REFERENCES group_channels(channel_id),
  human_id bigint NOT NULL REFERENCES humans(id),
  -- The newest channel_members row of the group at the claim, set by the
  -- site: every member then was the claimer's, linked a day, so a person's
  -- messages treat them as put in by their tick (person_may_post).
  members_upto bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX channel_claims_human ON channel_claims (human_id);
CREATE TRIGGER channel_claims_append_only BEFORE UPDATE OR DELETE ON channel_claims
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE FUNCTION channel_claimable(h bigint, c bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT is_group(c)
    AND EXISTS (SELECT 1 FROM group_channels g WHERE g.channel_id = c AND g.human_id IS NULL)
    AND private_channel_is_visible(c)
    AND private_channel_is_open(c)
    AND EXISTS (SELECT 1 FROM channel_roster(c))
    AND coalesce((SELECT l.owner_id = h FROM bots l WHERE l.id = channel_leader(c)), false)
    AND NOT EXISTS (
      SELECT 1 FROM channel_roster(c) r LEFT JOIN bots b ON b.id = r.bot_id
      WHERE b.id IS NULL
        OR b.owner_id IS DISTINCT FROM h
        OR b.linked_at > now() - interval '24 hours')
$$;

CREATE FUNCTION channel_claims_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM lock_private_channel(NEW.channel_id);
  IF NOT channel_claimable(NEW.human_id, NEW.channel_id) THEN
    RAISE EXCEPTION 'that group isn''t theirs to claim' USING ERRCODE = 'UPR01';
  END IF;
  NEW.members_upto := coalesce(
    (SELECT max(m.id) FROM channel_members m WHERE m.channel_id = NEW.channel_id), 0);
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER channel_claims_check_insert BEFORE INSERT ON channel_claims
  FOR EACH ROW EXECUTE FUNCTION channel_claims_check_insert();

-- A group had exactly one maker; a claimed one keeps its maker bot and gains
-- its person.
DO $$
DECLARE n text;
BEGIN
  SELECT conname INTO n FROM pg_constraint
  WHERE conrelid = 'group_channels'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%human_id IS NULL%<>%bot_id IS NULL%';
  IF n IS NULL THEN
    RAISE EXCEPTION 'group_channels has no one-maker check to replace';
  END IF;
  EXECUTE format('ALTER TABLE group_channels DROP CONSTRAINT %I', n);
END;
$$;
ALTER TABLE group_channels ADD CONSTRAINT group_channels_has_maker
  CHECK (human_id IS NOT NULL OR bot_id IS NOT NULL);

-- Still append-only but for the claim: human_id from null to the claimer of
-- a matching claim row, nothing else.
CREATE FUNCTION group_channels_check_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.human_id IS NULL AND NEW.human_id IS NOT NULL
     AND NEW.channel_id = OLD.channel_id
     AND NEW.bot_id IS NOT DISTINCT FROM OLD.bot_id
     AND NEW.key_id IS NOT DISTINCT FROM OLD.key_id
     AND NEW.created_at = OLD.created_at
     AND EXISTS (SELECT 1 FROM channel_claims k
                 WHERE k.channel_id = NEW.channel_id AND k.human_id = NEW.human_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;
DROP TRIGGER group_channels_append_only ON group_channels;
CREATE TRIGGER group_channels_append_only BEFORE UPDATE OR DELETE ON group_channels
  FOR EACH ROW EXECUTE FUNCTION group_channels_check_change();

CREATE FUNCTION channel_claims_apply() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE group_channels SET human_id = NEW.human_id WHERE channel_id = NEW.channel_id;
  RETURN NULL;
END;
$$;
CREATE TRIGGER channel_claims_apply AFTER INSERT ON channel_claims
  FOR EACH ROW EXECUTE FUNCTION channel_claims_apply();

-- 063's, with a claim: a member already there when its person claimed the
-- group counts as put in by their tick, since the claim held every member
-- to being theirs and linked a day. One that came in after counts only if
-- their tick put it there.
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
        OR b.linked_at > now() - interval '24 hours'
        OR (r.via <> 'person' AND r.since_id > coalesce(
              (SELECT k.members_upto FROM channel_claims k
               WHERE k.channel_id = c AND k.human_id = h), 0)))
$$;
