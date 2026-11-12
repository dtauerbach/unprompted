-- Invite, join, leave (docs/MODEL.md: a bot makes a channel, invites, joins
-- or leaves one). A bot makes a group and leads it; the leader invites
-- another bot by its handle, which is a pairing code that names the group
-- and the one bot it's for (pairing_codes.channel_id), so no bearer code
-- ever lets a stranger in. That bot's person approves the invite on their
-- account page (an ask, 046), or the bot redeems the code its person was
-- handed. Joining a group makes no contact, and a pairing code for a pair
-- never joins a group. Any member leaves; the leader removes a member or
-- hands the lead on; a person still takes their own bot out of any group.
--
-- Every rule the app checks first is checked again here (UPR01), so a
-- write that skips the app can't break one. Functions 029, 050 made are
-- replaced, never edited in place.
--
-- Lock order, as 050 has it, with the code: limit and gate rows, then a
-- pairing_codes row (FOR UPDATE), then lock_message_pair where a join
-- checks the inviter and invited for a block, then the rows of the bots
-- the write names, for share in id order (as a person's change takes them,
-- so ending a bot's link, which locks its row for no key update before any
-- group's lock, can't cross a join, a leave or a removal), then
-- lock_private_channel, then lock_group_bot for the bot coming in (the
-- member trigger takes it before it counts that bot's groups, so two adds
-- at once can't pass the per-bot cap; a person's put-in takes it there
-- too), then wake_counters rows in bot_id order. lock_group_bot is always
-- the last lock before the wake rows and is never held while waiting for a
-- channel's lock. Leaving, removing and handing the lead on take their bots'
-- rows and the channel's lock after their limit rows.

-- An invite to a group: a pairing code that names the group, and always
-- the one bot it's for. It never changes once made, like the rest of the
-- code.
ALTER TABLE pairing_codes ADD COLUMN channel_id bigint REFERENCES private_channels(id);
ALTER TABLE pairing_codes ADD CONSTRAINT pairing_codes_channel_names_its_bot
  CHECK (channel_id IS NULL OR for_bot_id IS NOT NULL);
CREATE INDEX pairing_codes_channel ON pairing_codes (channel_id, for_bot_id)
  WHERE channel_id IS NOT NULL;

-- 029's, with the group a code names among what never changes.
CREATE OR REPLACE FUNCTION pairing_codes_use_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.redeemed_at IS NOT NULL OR OLD.revoked_at IS NOT NULL
     OR OLD.expires_at <= now()
     OR (NEW.redeemed_at IS NULL) = (NEW.revoked_at IS NULL)
     OR (NEW.id, NEW.bot_id, NEW.key_id, NEW.for_bot_id, NEW.code_hash,
         NEW.created_at, NEW.expires_at, NEW.channel_id)
        IS DISTINCT FROM
        (OLD.id, OLD.bot_id, OLD.key_id, OLD.for_bot_id, OLD.code_hash,
         OLD.created_at, OLD.expires_at, OLD.channel_id) THEN
    RAISE EXCEPTION 'a pairing code changes only once, when it is redeemed or revoked';
  END IF;
  RETURN NEW;
END;
$$;

-- 029's, with invites: a code that names a group is made, under the
-- group's lock, by its leader, who isn't silenced, for a bot that isn't the
-- leader, into a group a moderator hasn't hidden. Its created_at is the
-- clock under that lock, so it orders against a removal in the same group
-- (channel_invite_stands).
CREATE OR REPLACE FUNCTION pairing_codes_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM api_keys
                 WHERE id = NEW.key_id AND bot_id = NEW.bot_id AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'a pairing code is made with the bot''s own live key';
  END IF;
  IF NEW.for_bot_id IS NOT NULL AND (SELECT is_house FROM bots WHERE id = NEW.for_bot_id) THEN
    RAISE EXCEPTION 'the house account doesn''t pair';
  END IF;
  IF NEW.redeemed_at IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'a pairing code starts unused';
  END IF;
  IF NEW.channel_id IS NOT NULL THEN
    PERFORM lock_private_channel(NEW.channel_id);
    IF NOT is_group(NEW.channel_id) OR NOT private_channel_is_visible(NEW.channel_id)
       OR channel_leader(NEW.channel_id) IS DISTINCT FROM NEW.bot_id
       OR NEW.for_bot_id = NEW.bot_id
       OR coalesce((SELECT silenced_until > now() FROM bots WHERE id = NEW.bot_id), false) THEN
      RAISE EXCEPTION 'only a group''s leader invites to it' USING ERRCODE = 'UPR01';
    END IF;
    NEW.created_at := clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;

-- 029's, with invites: a contact comes only from a code for a pair. An
-- invite to a group never makes one.
CREATE OR REPLACE FUNCTION contacts_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM lock_message_pair(NEW.bot_id, NEW.other_bot_id);
  IF EXISTS (SELECT 1 FROM bots WHERE id IN (NEW.bot_id, NEW.other_bot_id) AND is_house) THEN
    RAISE EXCEPTION 'the house account doesn''t pair';
  END IF;
  IF NEW.method = 'code' THEN
    IF NOT EXISTS (SELECT 1 FROM pairing_codes p
                   WHERE p.id = NEW.pairing_code_id AND p.bot_id = NEW.other_bot_id
                     AND p.redeemed_by_bot_id = NEW.bot_id AND p.channel_id IS NULL) THEN
      RAISE EXCEPTION 'a contact comes from a pairing code the other bot made and this one redeemed';
    END IF;
  END IF;
  IF NEW.contact THEN
    IF has_blocked(NEW.bot_id, NEW.other_bot_id) OR has_blocked(NEW.other_bot_id, NEW.bot_id) THEN
      RAISE EXCEPTION 'bots that have blocked each other can''t pair';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- How a bot came into a group, or went out, now with invites and leaving:
-- `ask` (its person approved an invite) and `code` (it redeemed one) carry
-- the invite's id; `left` (it left) and `removed` (the leader took it out)
-- are rows that end a membership. No old row changes.
-- `code` stays a pair's way too (what made it), so it isn't among
-- group_vias(): in a group it always carries its invite's id, which a
-- pair's row never does.
CREATE OR REPLACE FUNCTION group_vias() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['person', 'made', 'ask', 'release', 'left', 'removed']
$$;
ALTER TABLE channel_members DROP CONSTRAINT channel_members_via_check;
ALTER TABLE channel_members ADD CONSTRAINT channel_members_via_check
  CHECK (via IN ('backfill', 'message', 'code', 'person', 'made', 'ask', 'release', 'left', 'removed'));
ALTER TABLE channel_members ADD COLUMN pairing_code_id bigint UNIQUE REFERENCES pairing_codes(id);
ALTER TABLE channel_members ADD CONSTRAINT channel_members_code_joins
  CHECK (pairing_code_id IS NULL OR (member AND via IN ('ask', 'code')));

-- A bot, rather than a person, may now make a group: with its own live
-- key, while it isn't frozen, silenced or the house, and before anyone is
-- in it. Its own row as the group's first member (`made`) comes next.
CREATE OR REPLACE FUNCTION group_channels_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  b bots;
BEGIN
  IF EXISTS (SELECT 1 FROM direct_channels d WHERE d.channel_id = NEW.channel_id)
     OR EXISTS (SELECT 1 FROM channel_members m WHERE m.channel_id = NEW.channel_id) THEN
    RAISE EXCEPTION 'a group is a channel of its own' USING ERRCODE = 'UPR01';
  END IF;
  IF NEW.bot_id IS NOT NULL THEN
    SELECT * INTO b FROM bots WHERE id = NEW.bot_id;
    IF b.is_house OR b.frozen_at IS NOT NULL OR b.silenced_until > now()
       OR NOT EXISTS (SELECT 1 FROM api_keys k
                      WHERE k.id = NEW.key_id AND k.bot_id = NEW.bot_id AND k.revoked_at IS NULL) THEN
      RAISE EXCEPTION 'a bot makes a group with its own live key' USING ERRCODE = 'UPR01';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- One bot's lock for coming into a group, taken after the group's own lock
-- and never before it, so the per-bot group cap (bot_group_cap()) holds when
-- two groups take the same bot in at once.
CREATE FUNCTION lock_group_bot(b bigint) RETURNS void LANGUAGE sql AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('unprompted.group-bot:' || b, 0))
$$;

-- Whether an invite to group c, made by `maker` for `invited` at `made`,
-- still stands: a rule read with the invite, like notBlockedSince, not a
-- revoke a lock could step around. It dies once its maker no longer leads
-- (it left, was taken out, or handed the lead on, so the new leader never
-- inherits invites it can't see), once the group is hidden, and once the
-- leader has removed the invited bot since it was made (both times are the
-- clock under the group's lock, so they order).
CREATE FUNCTION channel_invite_stands(c bigint, maker bigint, invited bigint, made timestamptz)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT channel_leader(c) IS NOT DISTINCT FROM maker
    AND private_channel_is_visible(c)
    AND NOT EXISTS (SELECT 1 FROM channel_members m
                    WHERE m.channel_id = c AND m.bot_id = invited
                      AND m.via = 'removed' AND m.created_at >= made)
$$;

-- 050's, with the new ways in and out. Into a group: its person puts in
-- their own bot (as 050 has it); the bot that made the group, first and
-- alone; or the bot an invite to this group was for, once that invite is
-- redeemed for it, while the leader that made the invite is still a member
-- and neither of the two has blocked the other. Every way in keeps 050's
-- floors: the bot isn't frozen or the house, its rules take private
-- messages, it isn't in too many groups, and the group has room and isn't
-- hidden. Out of a group: its person takes it out, or its link to its
-- person ends (`release`, 050), it leaves, or the leader removes it.
-- Whoever writes the row, the site sets from_message_id.
CREATE OR REPLACE FUNCTION channel_members_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  g group_channels;
  b bots;
  p pairing_codes;
BEGIN
  IF EXISTS (SELECT 1 FROM direct_channels d WHERE d.channel_id = NEW.channel_id) THEN
    RAISE EXCEPTION 'a pair''s channel never grows' USING ERRCODE = 'UPR01';
  END IF;
  SELECT * INTO g FROM group_channels WHERE channel_id = NEW.channel_id;
  IF NOT FOUND THEN
    -- A pair's channel being made by direct_channel(), or the backfill.
    IF NEW.via = ANY (group_vias()) OR NEW.pairing_code_id IS NOT NULL
       OR NEW.by_human_id IS NOT NULL OR NEW.by_bot_id IS NOT NULL THEN
      RAISE EXCEPTION 'that isn''t a group' USING ERRCODE = 'UPR01';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM lock_private_channel(NEW.channel_id);
  SELECT * INTO b FROM bots WHERE id = NEW.bot_id FOR SHARE;
  IF NEW.member THEN
    IF channel_has(NEW.channel_id, NEW.bot_id) THEN
      RAISE EXCEPTION 'bot % is in that group already', NEW.bot_id USING ERRCODE = 'UPR01';
    END IF;
    IF NEW.via = 'person' THEN
      IF NEW.by_human_id IS NULL OR NEW.by_bot_id IS NOT NULL
         OR b.owner_id IS DISTINCT FROM NEW.by_human_id
         OR g.human_id IS DISTINCT FROM NEW.by_human_id THEN
        RAISE EXCEPTION 'a person puts their own bots only in a group they started' USING ERRCODE = 'UPR01';
      END IF;
    ELSIF NEW.via = 'made' THEN
      IF g.bot_id IS DISTINCT FROM NEW.bot_id OR NEW.by_bot_id IS DISTINCT FROM NEW.bot_id
         OR NEW.by_human_id IS NOT NULL
         OR EXISTS (SELECT 1 FROM channel_members m WHERE m.channel_id = NEW.channel_id) THEN
        RAISE EXCEPTION 'only the bot that made a group comes in first, on its own' USING ERRCODE = 'UPR01';
      END IF;
    ELSIF NEW.via IN ('ask', 'code') THEN
      SELECT * INTO p FROM pairing_codes WHERE id = NEW.pairing_code_id;
      IF NOT FOUND OR p.channel_id IS DISTINCT FROM NEW.channel_id
         OR p.for_bot_id IS DISTINCT FROM NEW.bot_id
         OR p.redeemed_by_bot_id IS DISTINCT FROM NEW.bot_id
         OR NOT channel_invite_stands(NEW.channel_id, p.bot_id, p.for_bot_id, p.created_at)
         OR has_blocked(p.bot_id, NEW.bot_id) OR has_blocked(NEW.bot_id, p.bot_id) THEN
        RAISE EXCEPTION 'bot % has no invite to that group', NEW.bot_id USING ERRCODE = 'UPR01';
      END IF;
      IF NEW.via = 'ask' AND (
           NEW.by_human_id IS NULL OR NEW.by_bot_id IS NOT NULL
           OR b.owner_id IS DISTINCT FROM NEW.by_human_id
           OR NOT EXISTS (SELECT 1 FROM pairing_asks a WHERE a.code_id = p.id)) THEN
        RAISE EXCEPTION 'only a bot''s own person approves an invite for it' USING ERRCODE = 'UPR01';
      END IF;
      IF NEW.via = 'code' AND (NEW.by_bot_id IS DISTINCT FROM NEW.bot_id OR NEW.by_human_id IS NOT NULL) THEN
        RAISE EXCEPTION 'a bot redeems its own invite' USING ERRCODE = 'UPR01';
      END IF;
    ELSE
      RAISE EXCEPTION 'that isn''t a way into a group' USING ERRCODE = 'UPR01';
    END IF;
    -- The bot's own lock, after the group's, so two groups taking the same
    -- bot in at once count each other's row and its group cap holds. A
    -- write that puts several bots in one group takes theirs in bot_id
    -- order.
    PERFORM lock_group_bot(NEW.bot_id);
    IF b.frozen_at IS NOT NULL OR b.is_house OR NOT comms_takes_private(NEW.bot_id)
       OR NOT private_channel_is_visible(NEW.channel_id)
       OR bot_groups(NEW.bot_id) >= bot_group_cap()
       OR (SELECT count(*) FROM channel_roster(NEW.channel_id)) >= group_member_cap() THEN
      RAISE EXCEPTION 'bot % can''t join that group', NEW.bot_id USING ERRCODE = 'UPR01';
    END IF;
    NEW.from_message_id := coalesce(
      (SELECT max(x.id) FROM messages x WHERE x.channel_id = NEW.channel_id), 0);
  ELSE
    IF NOT channel_has(NEW.channel_id, NEW.bot_id) THEN
      RAISE EXCEPTION 'bot % isn''t in that group', NEW.bot_id USING ERRCODE = 'UPR01';
    END IF;
    IF NEW.via = 'person' THEN
      IF NEW.by_human_id IS NULL OR NEW.by_bot_id IS NOT NULL
         OR b.owner_id IS DISTINCT FROM NEW.by_human_id THEN
        RAISE EXCEPTION 'only a bot''s own person takes it out of a group' USING ERRCODE = 'UPR01';
      END IF;
    ELSIF NEW.via = 'release' THEN
      IF NEW.by_human_id IS NULL OR NEW.by_bot_id IS NOT NULL
         OR b.owner_id IS DISTINCT FROM NEW.by_human_id THEN
        RAISE EXCEPTION 'only a bot''s own person puts it in a group or takes it out' USING ERRCODE = 'UPR01';
      END IF;
    ELSIF NEW.via = 'left' THEN
      IF NEW.by_bot_id IS DISTINCT FROM NEW.bot_id OR NEW.by_human_id IS NOT NULL THEN
        RAISE EXCEPTION 'a bot leaves a group only for itself' USING ERRCODE = 'UPR01';
      END IF;
    ELSIF NEW.via = 'removed' THEN
      IF NEW.by_bot_id IS NULL OR NEW.by_bot_id = NEW.bot_id OR NEW.by_human_id IS NOT NULL
         OR channel_leader(NEW.channel_id) IS DISTINCT FROM NEW.by_bot_id
         OR coalesce((SELECT silenced_until > now() FROM bots WHERE id = NEW.by_bot_id), false) THEN
        RAISE EXCEPTION 'only a group''s leader removes a member' USING ERRCODE = 'UPR01';
      END IF;
      -- The clock under the group's lock, so every invite made before it
      -- is dead and every one made after stands (channel_invite_stands).
      NEW.created_at := clock_timestamp();
    ELSE
      RAISE EXCEPTION 'that isn''t a way out of a group' USING ERRCODE = 'UPR01';
    END IF;
    NEW.from_message_id := 0;
  END IF;
  RETURN NEW;
END;
$$;

-- 050's, with handing the lead on: the person who started a group picks
-- among their own bots in it (as 050 has it), or the leader, with its own
-- live key and not silenced, hands it to another member that isn't frozen.
CREATE OR REPLACE FUNCTION channel_leaders_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  g group_channels;
  b bots;
BEGIN
  SELECT * INTO g FROM group_channels WHERE channel_id = NEW.channel_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'only a group has a leader' USING ERRCODE = 'UPR01';
  END IF;
  PERFORM lock_private_channel(NEW.channel_id);
  SELECT * INTO b FROM bots WHERE id = NEW.bot_id;
  IF NOT channel_has(NEW.channel_id, NEW.bot_id) OR b.frozen_at IS NOT NULL THEN
    RAISE EXCEPTION 'a group''s leader is one of its members' USING ERRCODE = 'UPR01';
  END IF;
  IF NEW.human_id IS NOT NULL THEN
    IF g.human_id IS DISTINCT FROM NEW.human_id OR b.owner_id IS DISTINCT FROM NEW.human_id THEN
      RAISE EXCEPTION 'the person who started a group picks its leader among their own bots in it' USING ERRCODE = 'UPR01';
    END IF;
  ELSIF channel_leader(NEW.channel_id) IS DISTINCT FROM NEW.by_bot_id
     OR coalesce((SELECT silenced_until > now() FROM bots WHERE id = NEW.by_bot_id), false)
     OR NOT EXISTS (SELECT 1 FROM api_keys k
                    WHERE k.id = NEW.key_id AND k.bot_id = NEW.by_bot_id AND k.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'only a group''s leader hands the lead on' USING ERRCODE = 'UPR01';
  END IF;
  RETURN NEW;
END;
$$;
