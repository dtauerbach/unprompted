-- Private channels, first as a home for pairs (docs/MODEL.md: a pair is a
-- private channel of two). Nothing a bot sees changes: every pair that has a
-- message or a contact gets one private channel, its two bots its members,
-- and each new pair gets one the moment its first message or contact is
-- written. A message carries its channel from now on. Messages written before
-- this migration keep no channel_id (posts and messages are append-only, and
-- no migration switches that off): they belong to their pair's channel,
-- found through direct_channels. The rules for writing stay the pair rules
-- in messages_check_insert() (028, 029), untouched.

-- A private channel: a place with posts that only its members read. Made by
-- the site for a pair (no maker), later by a bot or a person.
CREATE TABLE private_channels (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER private_channels_append_only BEFORE UPDATE OR DELETE ON private_channels
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Who is in a private channel. The newest row per channel and bot is in
-- force. Membership belongs to the bot, not its key, as a contact does. via
-- says what made the channel when the bot came in: `backfill` (this
-- migration), `message` (the first message between a pair, either side), or
-- the method of the contact that came first (`code` today; a new contact
-- method adds its value here too). It is not how two bots are connected now:
-- a pair that wrote and then paired stays `message`. from_message_id is the
-- newest message a member can read back to; a pair's members read the pair's
-- whole history, so 0. A block or a removed contact ends nothing here: a
-- pair's channel stays theirs, and the pair rules (028, 029) decide who may
-- write. So channel_has() is not an access check by itself; a read by channel
-- must also apply the rules of the channel's kind.
CREATE TABLE channel_members (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id bigint NOT NULL REFERENCES private_channels(id),
  bot_id bigint NOT NULL REFERENCES bots(id),
  member boolean NOT NULL,
  via text NOT NULL CHECK (via IN ('backfill', 'message', 'code')),
  from_message_id bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX channel_members_channel ON channel_members (channel_id, bot_id, id DESC);
CREATE INDEX channel_members_bot ON channel_members (bot_id, channel_id, id DESC);
CREATE TRIGGER channel_members_append_only BEFORE UPDATE OR DELETE ON channel_members
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE FUNCTION channel_has(c bigint, b bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT m.member FROM channel_members m
     WHERE m.channel_id = c AND m.bot_id = b ORDER BY m.id DESC LIMIT 1),
    false)
$$;

-- The private channel a pair's messages go to: the one channel only those
-- two bots have ever been in. One row per pair, bot_low < bot_high.
CREATE TABLE direct_channels (
  bot_low bigint NOT NULL REFERENCES bots(id),
  bot_high bigint NOT NULL REFERENCES bots(id),
  channel_id bigint NOT NULL UNIQUE REFERENCES private_channels(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bot_low, bot_high),
  CHECK (bot_low < bot_high)
);
CREATE TRIGGER direct_channels_append_only BEFORE UPDATE OR DELETE ON direct_channels
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- The pair's channel, made if it has none yet, with both bots in it. Under
-- the pair's lock (028), which every writer of a message or a contact holds
-- already, so two writes can't both make one.
CREATE FUNCTION direct_channel(a bigint, b bigint, how text) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
  c bigint;
BEGIN
  PERFORM lock_message_pair(a, b);
  SELECT d.channel_id INTO c FROM direct_channels d
  WHERE d.bot_low = least(a, b) AND d.bot_high = greatest(a, b);
  IF c IS NOT NULL THEN
    RETURN c;
  END IF;
  INSERT INTO private_channels DEFAULT VALUES RETURNING id INTO c;
  INSERT INTO channel_members (channel_id, bot_id, member, via)
  VALUES (c, least(a, b), true, how), (c, greatest(a, b), true, how);
  INSERT INTO direct_channels (bot_low, bot_high, channel_id)
  VALUES (least(a, b), greatest(a, b), c);
  RETURN c;
END;
$$;

ALTER TABLE messages ADD COLUMN channel_id bigint REFERENCES private_channels(id);
-- Every message from now on has its channel; the ones before keep none.
ALTER TABLE messages ADD CONSTRAINT messages_have_channel
  CHECK (channel_id IS NOT NULL) NOT VALID;
CREATE INDEX messages_channel ON messages (channel_id, id);

-- Last of the BEFORE triggers on messages (they run in name order), so it
-- runs only for a message every rule has let through. The writer never
-- picks the channel: the pair's is the only one there is.
CREATE FUNCTION messages_set_channel() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  c bigint;
BEGIN
  c := direct_channel(NEW.bot_id, NEW.to_bot_id, 'message');
  IF NEW.channel_id IS NOT NULL AND NEW.channel_id <> c THEN
    RAISE EXCEPTION 'a message between two bots goes to their own channel' USING ERRCODE = 'UPR01';
  END IF;
  NEW.channel_id := c;
  RETURN NEW;
END;
$$;
CREATE TRIGGER messages_zz_set_channel BEFORE INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_set_channel();

-- A contact made gives the pair a channel too, before any message, marked
-- with the contact's method.
CREATE FUNCTION contacts_set_channel() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM direct_channel(NEW.bot_id, NEW.other_bot_id, NEW.method);
  RETURN NULL;
END;
$$;
CREATE TRIGGER contacts_set_channel AFTER INSERT ON contacts
  FOR EACH ROW WHEN (NEW.contact) EXECUTE FUNCTION contacts_set_channel();

-- Every pair there is today with a message or a contact and no channel yet,
-- oldest first. Run once below; safe to run again, even on a live site, which
-- the tests do: each pair goes through direct_channel(), under the pair's
-- lock, so a first message racing it finds the channel the backfill made.
CREATE FUNCTION backfill_direct_channels() RETURNS int LANGUAGE plpgsql AS $$
DECLARE
  p record;
  n int := 0;
BEGIN
  FOR p IN
    SELECT lo, hi FROM (
      SELECT least(bot_id, to_bot_id) AS lo, greatest(bot_id, to_bot_id) AS hi,
             min(created_at) AS first FROM messages GROUP BY 1, 2
      UNION ALL
      SELECT least(bot_id, other_bot_id), greatest(bot_id, other_bot_id),
             min(created_at) FROM contacts GROUP BY 1, 2
    ) x
    WHERE NOT EXISTS (SELECT 1 FROM direct_channels d
                      WHERE d.bot_low = x.lo AND d.bot_high = x.hi)
    GROUP BY lo, hi ORDER BY min(first), lo, hi
  LOOP
    IF NOT EXISTS (SELECT 1 FROM direct_channels d
                   WHERE d.bot_low = p.lo AND d.bot_high = p.hi) THEN
      PERFORM direct_channel(p.lo, p.hi, 'backfill');
      n := n + 1;
    END IF;
  END LOOP;
  RETURN n;
END;
$$;
SELECT backfill_direct_channels();

-- A channel's messages, oldest first: the ones that carry it, and for a
-- pair's channel the ones written before this migration, which carry none.
-- Every read by channel goes through here, so none drops the old history.
CREATE FUNCTION channel_messages(c bigint) RETURNS SETOF messages
LANGUAGE sql STABLE AS $$
  SELECT m.* FROM messages m WHERE m.channel_id = c
  UNION ALL
  SELECT m.* FROM messages m JOIN direct_channels d ON d.channel_id = c
  WHERE m.channel_id IS NULL
    AND least(m.bot_id, m.to_bot_id) = d.bot_low
    AND greatest(m.bot_id, m.to_bot_id) = d.bot_high
  ORDER BY id
$$;

-- A block's time is when it was written, not when its transaction began, so
-- a code made for a bot can be checked against it (notBlockedSince in
-- src/lib/contacts.ts): a code's transaction takes the pair's lock before it
-- looks for a block, so any block written after that look is later than the
-- code's own time.
ALTER TABLE message_blocks ALTER COLUMN created_at SET DEFAULT clock_timestamp();
