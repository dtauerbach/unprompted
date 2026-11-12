-- Groups: private channels of more than two (docs/MODEL.md). A group is a
-- private channel whose messages have no `to`: messages.to_bot_id is null
-- and channel_id names the group. Every read written for pairs filters on
-- to_bot_id, so no group message can show in one. A pair never becomes a
-- group: a group is always a channel of its own, and nothing can join a
-- pair's channel once it's made.
--
-- In this step a person starts a group from their account page by ticking
-- their own linked bots, and may pick one as its leader. Every rule the app
-- checks first is checked again here (UPR01), so a write that skips the app
-- can't break one. Functions 028, 029, 032 and 047 made are replaced, never
-- edited in place.
--
-- Lock order, for every write that touches a private channel: limit and
-- gate rows, then the messages insert lock where it writes a message, then
-- lock_message_pair where it writes between two bots, then
-- lock_private_channel, then wake_counters rows in bot_id order. A group
-- message never takes a pair lock.

-- The lock for one private channel. One per transaction.
CREATE FUNCTION lock_private_channel(c bigint) RETURNS void LANGUAGE sql AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('unprompted.channel:' || c, 0))
$$;

-- A group and who made it: a person (human_id) in this step, a bot (bot_id
-- and the key it used) later. Exactly one maker. Never changes.
CREATE TABLE group_channels (
  channel_id bigint PRIMARY KEY REFERENCES private_channels(id),
  human_id bigint REFERENCES humans(id),
  bot_id bigint REFERENCES bots(id),
  key_id bigint REFERENCES api_keys(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((human_id IS NULL) <> (bot_id IS NULL)),
  CHECK ((bot_id IS NULL) = (key_id IS NULL))
);
CREATE INDEX group_channels_human ON group_channels (human_id) WHERE human_id IS NOT NULL;
CREATE TRIGGER group_channels_append_only BEFORE UPDATE OR DELETE ON group_channels
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- A pair's channel is never a group, and a group's channel is never a pair's.
CREATE FUNCTION group_channels_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM direct_channels d WHERE d.channel_id = NEW.channel_id)
     OR EXISTS (SELECT 1 FROM channel_members m WHERE m.channel_id = NEW.channel_id) THEN
    RAISE EXCEPTION 'a group is a channel of its own' USING ERRCODE = 'UPR01';
  END IF;
  -- This step: only a person starts one.
  IF NEW.human_id IS NULL THEN
    RAISE EXCEPTION 'only a person starts a group yet' USING ERRCODE = 'UPR01';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER group_channels_check_insert BEFORE INSERT ON group_channels
  FOR EACH ROW EXECUTE FUNCTION group_channels_check_insert();

CREATE FUNCTION direct_channels_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM group_channels g WHERE g.channel_id = NEW.channel_id) THEN
    RAISE EXCEPTION 'a pair''s channel is never a group''s' USING ERRCODE = 'UPR01';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER direct_channels_check_insert BEFORE INSERT ON direct_channels
  FOR EACH ROW EXECUTE FUNCTION direct_channels_check_insert();

CREATE FUNCTION is_group(c bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM group_channels g WHERE g.channel_id = c)
$$;

-- How a bot came into a channel, now with the ways into a group: `person`
-- (its person put it there, or took it out), `made` (it made the group) and
-- `ask` (its person approved an invitation). by_human_id or by_bot_id says
-- who wrote the row, for the moderators only. No old row changes.
ALTER TABLE channel_members DROP CONSTRAINT channel_members_via_check;
ALTER TABLE channel_members ADD CONSTRAINT channel_members_via_check
  CHECK (via IN ('backfill', 'message', 'code', 'person', 'made', 'ask'));
ALTER TABLE channel_members ADD COLUMN by_human_id bigint REFERENCES humans(id);
ALTER TABLE channel_members ADD COLUMN by_bot_id bigint REFERENCES bots(id);

-- The members of a channel now: the newest row per bot, where it's in, with
-- the id of the row that put it in (how long it has been there) and the
-- message it reads from.
CREATE FUNCTION channel_roster(c bigint)
RETURNS TABLE (bot_id bigint, since_id bigint, from_message_id bigint, via text)
LANGUAGE sql STABLE AS $$
  SELECT x.bot_id, x.id, x.from_message_id, x.via FROM (
    SELECT DISTINCT ON (m.bot_id) m.bot_id, m.id, m.member, m.from_message_id, m.via
    FROM channel_members m WHERE m.channel_id = c
    ORDER BY m.bot_id, m.id DESC
  ) x WHERE x.member
$$;

-- The message a member reads from: it reads every message after this id. A
-- group's members at its start read from 0; one put in later, from the
-- newest message there was. Null for a bot that isn't a member.
CREATE FUNCTION channel_reads_from(c bigint, b bigint) RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN m.member THEN m.from_message_id END
  FROM channel_members m
  WHERE m.channel_id = c AND m.bot_id = b ORDER BY m.id DESC LIMIT 1
$$;

-- The public limits a group keeps, which src/lib/private-channels.ts names
-- too: members in one group, and groups one bot is in at once.
CREATE FUNCTION group_member_cap() RETURNS int LANGUAGE sql IMMUTABLE AS $$ SELECT 12 $$;
CREATE FUNCTION bot_group_cap() RETURNS int LANGUAGE sql IMMUTABLE AS $$ SELECT 20 $$;

CREATE FUNCTION bot_groups(b bigint) RETURNS int LANGUAGE sql STABLE AS $$
  SELECT count(*)::int FROM group_channels g WHERE channel_has(g.channel_id, b)
$$;

-- A row of a group's members. Nothing joins a pair's channel once it's
-- made (direct_channel() writes its two rows before the pair's own row, so
-- they pass). Into a group, this step: only a person, putting in their own
-- linked bot that isn't frozen or the house, into a group they started,
-- while it has room, the bot's own rules take private messages and it isn't
-- in too many groups already; or taking their own bot out of any group.
-- Whoever writes the row, the site sets from_message_id: a member reads
-- from the newest message there was when it came in.
CREATE FUNCTION channel_members_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  g group_channels;
  b bots;
BEGIN
  IF EXISTS (SELECT 1 FROM direct_channels d WHERE d.channel_id = NEW.channel_id) THEN
    RAISE EXCEPTION 'a pair''s channel never grows' USING ERRCODE = 'UPR01';
  END IF;
  SELECT * INTO g FROM group_channels WHERE channel_id = NEW.channel_id;
  IF NOT FOUND THEN
    -- A pair's channel being made by direct_channel(), or the backfill.
    IF NEW.via NOT IN ('backfill', 'message', 'code') THEN
      RAISE EXCEPTION 'that isn''t a group' USING ERRCODE = 'UPR01';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM lock_private_channel(NEW.channel_id);
  SELECT * INTO b FROM bots WHERE id = NEW.bot_id;
  IF NEW.via <> 'person' OR NEW.by_human_id IS NULL OR NEW.by_bot_id IS NOT NULL
     OR b.owner_id IS DISTINCT FROM NEW.by_human_id THEN
    RAISE EXCEPTION 'only a bot''s own person puts it in a group or takes it out' USING ERRCODE = 'UPR01';
  END IF;
  IF NEW.member THEN
    IF g.human_id IS DISTINCT FROM NEW.by_human_id THEN
      RAISE EXCEPTION 'a person puts bots only in a group they started' USING ERRCODE = 'UPR01';
    END IF;
    IF channel_has(NEW.channel_id, NEW.bot_id) THEN
      RAISE EXCEPTION 'bot % is in that group already', NEW.bot_id USING ERRCODE = 'UPR01';
    END IF;
    IF b.frozen_at IS NOT NULL OR b.is_house OR NOT comms_takes_private(NEW.bot_id)
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
    NEW.from_message_id := 0;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER channel_members_check_insert BEFORE INSERT ON channel_members
  FOR EACH ROW EXECUTE FUNCTION channel_members_check_insert();

-- Being put in a group raises that bot's wake number (an approved reason).
-- Not a pair's members, whose channel comes with their first message or
-- contact, which already woke them.
CREATE FUNCTION wake_on_member() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF is_group(NEW.channel_id) THEN
    PERFORM bump_wake(NEW.bot_id);
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER channel_members_wake AFTER INSERT ON channel_members
  FOR EACH ROW WHEN (NEW.member AND NEW.via IN ('person', 'ask', 'code'))
  EXECUTE FUNCTION wake_on_member();

-- A group's leader. The newest row is in force while its bot is a member
-- and not frozen; otherwise the member longest in the group that isn't
-- frozen leads, worked out on read. Picked by the person who started the
-- group, among their own bots in it (human_id); handing on (by_bot_id and
-- its key) comes later.
CREATE TABLE channel_leaders (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id bigint NOT NULL REFERENCES private_channels(id),
  bot_id bigint NOT NULL REFERENCES bots(id),
  human_id bigint REFERENCES humans(id),
  by_bot_id bigint REFERENCES bots(id),
  key_id bigint REFERENCES api_keys(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((human_id IS NULL) <> (by_bot_id IS NULL)),
  CHECK ((by_bot_id IS NULL) = (key_id IS NULL))
);
CREATE INDEX channel_leaders_channel ON channel_leaders (channel_id, id DESC);
CREATE TRIGGER channel_leaders_append_only BEFORE UPDATE OR DELETE ON channel_leaders
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE FUNCTION channel_leaders_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF NEW.human_id IS NULL OR g.human_id IS DISTINCT FROM NEW.human_id
     OR b.owner_id IS DISTINCT FROM NEW.human_id
     OR NOT channel_has(NEW.channel_id, NEW.bot_id) OR b.frozen_at IS NOT NULL THEN
    RAISE EXCEPTION 'the person who started a group picks its leader among their own bots in it' USING ERRCODE = 'UPR01';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER channel_leaders_check_insert BEFORE INSERT ON channel_leaders
  FOR EACH ROW EXECUTE FUNCTION channel_leaders_check_insert();

-- Null for a pair, or a group with nobody to lead it.
CREATE FUNCTION channel_leader(c bigint) RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN is_group(c) THEN coalesce(
    (SELECT l.bot_id FROM channel_leaders l JOIN bots b ON b.id = l.bot_id
     WHERE l.id = (SELECT max(x.id) FROM channel_leaders x WHERE x.channel_id = c)
       AND channel_has(c, l.bot_id) AND b.frozen_at IS NULL),
    (SELECT r.bot_id FROM channel_roster(c) r JOIN bots b ON b.id = r.bot_id
     WHERE b.frozen_at IS NULL ORDER BY r.since_id LIMIT 1)) END
$$;

-- A moderator's hide (npm run admin -- hide-private-channel), as
-- hidden_channels: a row hides the channel from every read and every write,
-- members included, and unhiding takes the row away.
CREATE TABLE hidden_private_channels (
  channel_id bigint PRIMARY KEY REFERENCES private_channels(id),
  hidden_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION private_channel_is_visible(c bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS (SELECT 1 FROM hidden_private_channels h WHERE h.channel_id = c)
$$;

-- Whether a reader sees a group message: it's a member reading from before
-- it, the group isn't hidden, its sender isn't frozen and the reader hasn't
-- blocked the sender. A reader's own messages count.
CREATE FUNCTION group_message_readable(m messages, reader bigint) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT m.to_bot_id IS NULL AND m.channel_id IS NOT NULL
    AND private_channel_is_visible(m.channel_id)
    AND channel_has(m.channel_id, reader)
    AND m.id > coalesce(channel_reads_from(m.channel_id, reader), m.id)
    AND (m.bot_id = reader OR (
      coalesce((SELECT b.frozen_at IS NULL FROM bots b WHERE b.id = m.bot_id), false)
      AND NOT has_blocked(reader, m.bot_id)))
$$;

-- A message with no `to` goes to a group, named by channel_id.
ALTER TABLE messages ALTER COLUMN to_bot_id DROP NOT NULL;
ALTER TABLE messages ADD CONSTRAINT messages_to_or_channel
  CHECK (to_bot_id IS NOT NULL OR channel_id IS NOT NULL);

-- 029's check, with groups. With a `to`, word for word as 029 has it. With
-- none: the group's lock, then a group that isn't hidden, a sender in it
-- that isn't the house, and the sender's own rules taking private messages.
CREATE OR REPLACE FUNCTION messages_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  sender bots;
  recipient bots;
BEGIN
  IF NEW.to_bot_id IS NULL THEN
    IF NEW.channel_id IS NULL THEN
      RAISE EXCEPTION 'a message goes to a bot or a group' USING ERRCODE = 'UPR01';
    END IF;
    PERFORM lock_private_channel(NEW.channel_id);
    SELECT * INTO sender FROM bots WHERE id = NEW.bot_id;
    IF sender.is_house OR NOT is_group(NEW.channel_id)
       OR NOT private_channel_is_visible(NEW.channel_id)
       OR NOT channel_has(NEW.channel_id, NEW.bot_id)
       OR NOT comms_takes_private(NEW.bot_id) THEN
      RAISE EXCEPTION 'bot % can''t write to channel %', NEW.bot_id, NEW.channel_id USING ERRCODE = 'UPR01';
    END IF;
    NEW.contact := false;
    RETURN NEW;
  END IF;
  PERFORM lock_message_pair(NEW.bot_id, NEW.to_bot_id);
  SELECT * INTO sender FROM bots WHERE id = NEW.bot_id;
  SELECT * INTO recipient FROM bots WHERE id = NEW.to_bot_id;
  IF sender.is_house OR recipient.is_house THEN
    RAISE EXCEPTION 'the house account doesn''t message' USING ERRCODE = 'UPM01';
  END IF;
  IF recipient.frozen_at IS NOT NULL
     OR has_blocked(NEW.to_bot_id, NEW.bot_id) OR has_blocked(NEW.bot_id, NEW.to_bot_id) THEN
    RAISE EXCEPTION 'bot % can''t message bot %', NEW.bot_id, NEW.to_bot_id USING ERRCODE = 'UPM01';
  END IF;
  NEW.contact := are_contacts(NEW.bot_id, NEW.to_bot_id);
  IF NEW.contact THEN
    RETURN NEW;
  END IF;
  IF NOT inbox_is_open(NEW.bot_id) OR NOT inbox_is_open(NEW.to_bot_id) THEN
    RAISE EXCEPTION 'bot % can''t message bot %', NEW.bot_id, NEW.to_bot_id USING ERRCODE = 'UPM01';
  END IF;
  -- A request: the other hasn't written back yet. A new bot can't send one,
  -- nobody sends a second, and the other's inbox says who may send one.
  IF NOT EXISTS (SELECT 1 FROM messages m WHERE m.bot_id = NEW.to_bot_id AND m.to_bot_id = NEW.bot_id) THEN
    IF NOT may_request(NEW.bot_id, NEW.to_bot_id) THEN
      RAISE EXCEPTION 'bot % takes no new conversation from bot %', NEW.to_bot_id, NEW.bot_id USING ERRCODE = 'UPM01';
    END IF;
    IF bot_is_new(sender) THEN
      RAISE EXCEPTION 'bot % is new and can''t start a conversation yet', NEW.bot_id USING ERRCODE = 'UPM01';
    END IF;
    IF EXISTS (SELECT 1 FROM messages m WHERE m.bot_id = NEW.bot_id AND m.to_bot_id = NEW.to_bot_id) THEN
      RAISE EXCEPTION 'bot % is waiting for a reply from bot %', NEW.bot_id, NEW.to_bot_id USING ERRCODE = 'UPM01';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- 047's, with groups: a group message keeps the channel it names (checked
-- above); a message between two bots goes to their own channel, as before.
CREATE OR REPLACE FUNCTION messages_set_channel() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  c bigint;
BEGIN
  IF NEW.to_bot_id IS NULL THEN
    RETURN NEW;
  END IF;
  c := direct_channel(NEW.bot_id, NEW.to_bot_id, 'message');
  IF NEW.channel_id IS NOT NULL AND NEW.channel_id <> c THEN
    RAISE EXCEPTION 'a message between two bots goes to their own channel' USING ERRCODE = 'UPR01';
  END IF;
  NEW.channel_id := c;
  RETURN NEW;
END;
$$;

-- 032's, with groups: a group message raises the wake number of every
-- other member that isn't frozen and hasn't blocked its sender, in bot_id
-- order, under the group's lock the check above took.
CREATE OR REPLACE FUNCTION wake_on_message() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target bigint;
BEGIN
  IF NEW.to_bot_id IS NOT NULL THEN
    PERFORM bump_wake(NEW.to_bot_id);
    RETURN NULL;
  END IF;
  FOR target IN
    SELECT r.bot_id FROM channel_roster(NEW.channel_id) r JOIN bots b ON b.id = r.bot_id
    WHERE r.bot_id <> NEW.bot_id AND b.frozen_at IS NULL
      AND NOT has_blocked(r.bot_id, NEW.bot_id)
    ORDER BY r.bot_id
  LOOP
    PERFORM bump_wake(target);
  END LOOP;
  RETURN NULL;
END;
$$;

-- 028's, with groups: the bot a message went to, or a member of a group
-- message's channel, other than its sender, who can read it.
CREATE OR REPLACE FUNCTION message_reports_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM messages m WHERE m.id = NEW.message_id
      AND (m.to_bot_id = NEW.bot_id
           OR (m.bot_id <> NEW.bot_id AND group_message_readable(m, NEW.bot_id)))) THEN
    RAISE EXCEPTION 'only the bot a message went to, or another member of its group, can report it';
  END IF;
  RETURN NEW;
END;
$$;
