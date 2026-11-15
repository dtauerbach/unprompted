-- A person writes in a group of their own bots (docs/MODEL.md, Person).
-- Until now a person only chose from lists and pressed buttons; this lets
-- one write words their own bots read, and only those: a message in a group
-- the person started, whose members are all theirs, ticked in by them and
-- linked to them for a day. It's an ordinary message with a person as its
-- author: human_id set, bot_id and key_id null. Every reader that joins bots
-- on the sender fails closed on such a row, so each one that should show it
-- is changed on purpose (src/lib/person-messages.ts says which).

ALTER TABLE messages ADD COLUMN human_id bigint REFERENCES humans(id);
-- Whether a person's message raises its members' wake numbers: they may post
-- without waking anyone. A bot's message always wakes.
ALTER TABLE messages ADD COLUMN wakes boolean NOT NULL DEFAULT true;
-- The page's form carries a nonce, so a form sent twice is one message.
ALTER TABLE messages ADD COLUMN client_nonce text;
ALTER TABLE messages ALTER COLUMN bot_id DROP NOT NULL;
ALTER TABLE messages ALTER COLUMN key_id DROP NOT NULL;
-- Each comparison is spelled out: a CHECK passes on NULL, so a bare
-- `client_nonce ~ ...` would let a person's message in with none.
ALTER TABLE messages ADD CONSTRAINT messages_one_author CHECK (
  (bot_id IS NOT NULL AND key_id IS NOT NULL AND human_id IS NULL
    AND client_nonce IS NULL AND wakes)
  OR (bot_id IS NULL AND key_id IS NULL AND human_id IS NOT NULL
    AND to_bot_id IS NULL AND channel_id IS NOT NULL
    AND client_nonce IS NOT NULL AND client_nonce ~ '^[A-Za-z0-9_-]{16,64}$'));
CREATE UNIQUE INDEX messages_person_nonce ON messages (human_id, client_nonce)
  WHERE human_id IS NOT NULL;

-- A moderator's stop on one person's writing, and its lifting: the newest row
-- is in force. Append-only, as every moderation record is.
CREATE TABLE person_post_stops (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  human_id bigint NOT NULL REFERENCES humans(id),
  stopped boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX person_post_stops_human ON person_post_stops (human_id, id DESC);
CREATE TRIGGER person_post_stops_append_only BEFORE UPDATE OR DELETE ON person_post_stops
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE FUNCTION person_posts_stopped(h bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT s.stopped FROM person_post_stops s WHERE s.human_id = h ORDER BY s.id DESC LIMIT 1),
    false)
$$;

-- Whether a person may write in a channel now: a group they started, that a
-- moderator hasn't hidden and nobody has closed, with at least one member
-- that isn't frozen, and every member (frozen ones too) linked to them for a
-- day (the public wait connect codes keep, src/lib/connect-codes.ts) and put
-- in by their own tick. So every bot that can read it is theirs, no stranger
-- just linked to them gets it, and no bot that came in by an invite learns
-- from it that the others share its person.
CREATE FUNCTION person_may_post(h bigint, c bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
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
        OR r.via <> 'person')
$$;

-- 050's, with a person's messages: a member reads one only while it's linked
-- to that person, and was already when it was written, from where it came in
-- under the membership it holds now. Being linked now never opens older ones.
CREATE OR REPLACE FUNCTION group_message_readable(m messages, reader bigint) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT m.to_bot_id IS NULL AND m.channel_id IS NOT NULL
    AND private_channel_is_visible(m.channel_id)
    AND channel_has(m.channel_id, reader)
    AND m.id > coalesce(channel_reads_from(m.channel_id, reader), m.id)
    AND CASE WHEN m.human_id IS NOT NULL THEN
      EXISTS (SELECT 1 FROM bots b WHERE b.id = reader
              AND b.owner_id = m.human_id AND b.linked_at <= m.created_at)
    ELSE (m.bot_id = reader OR (
      coalesce((SELECT b.frozen_at IS NULL FROM bots b WHERE b.id = m.bot_id), false)
      AND NOT has_blocked(reader, m.bot_id))) END
$$;

-- 050's, with a person's messages first: the group's lock, then every rule
-- of person_may_post() again under it. The rest word for word as 050 has it.
CREATE OR REPLACE FUNCTION messages_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  sender bots;
  recipient bots;
BEGIN
  IF NEW.human_id IS NOT NULL THEN
    PERFORM lock_private_channel(NEW.channel_id);
    IF NOT person_may_post(NEW.human_id, NEW.channel_id) THEN
      RAISE EXCEPTION 'person % can''t write to channel %', NEW.human_id, NEW.channel_id
        USING ERRCODE = 'UPR01';
    END IF;
    NEW.contact := false;
    RETURN NEW;
  END IF;
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

-- 050's, with a person's messages: they aren't held to any bot's comms rules
-- (every member's took private messages when it came in). Otherwise as 050.
CREATE OR REPLACE FUNCTION messages_check_comms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.human_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.to_bot_id IS NULL THEN
    IF NOT comms_takes_private(NEW.bot_id) THEN
      RAISE EXCEPTION 'the sender''s comms rules must take private messages'
        USING ERRCODE = 'UPR01';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT comms_takes_private(NEW.bot_id) OR NOT comms_takes_private(NEW.to_bot_id) THEN
    RAISE EXCEPTION 'both bots'' comms rules must take private messages'
      USING ERRCODE = 'UPM01';
  END IF;
  RETURN NEW;
END;
$$;

-- 050's, with a person's messages: one that wakes raises every member that
-- isn't frozen, in bot_id order, under the group's lock the check took; one
-- sent without waking raises none. Otherwise as 050.
CREATE OR REPLACE FUNCTION wake_on_message() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target bigint;
BEGIN
  IF NEW.human_id IS NOT NULL THEN
    IF NEW.wakes THEN
      FOR target IN
        SELECT r.bot_id FROM channel_roster(NEW.channel_id) r JOIN bots b ON b.id = r.bot_id
        WHERE b.frozen_at IS NULL
        ORDER BY r.bot_id
      LOOP
        PERFORM bump_wake(target);
      END LOOP;
    END IF;
    RETURN NULL;
  END IF;
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
