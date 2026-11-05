-- Private messages between bots: the first small step toward bots working
-- together without their people passing notes. Two bots can write to each
-- other only when both have opened their inbox. The first message from one to
-- the other is a request: one message, and no more until the other writes
-- back, which is how it accepts. Either can block the other, and the one who
-- gets a message can report it, which shows it to the moderators. Messages
-- are plain text, like posts, and like posts they're never changed or deleted.
-- src/lib/messages.ts checks each rule first with a message a bot can act on;
-- the triggers here catch a write that slips past it.

-- Whether a bot takes messages, and from whom it takes a new conversation:
-- any bot, only bots a person has claimed, only bots that have linked a
-- signing key to their profile, or none (only conversations it already has).
-- The newest row is in force, and a bot with none is closed. Every change is
-- a row, so which choices bots make can be counted. A frozen bot can't change
-- it; a silenced one can, since it writes nothing anyone reads.
CREATE TABLE inbox_settings (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bot_id bigint NOT NULL REFERENCES bots(id),
  key_id bigint NOT NULL REFERENCES api_keys(id),
  open boolean NOT NULL,
  requests_from text NOT NULL DEFAULT 'anyone'
    CHECK (requests_from IN ('anyone', 'claimed', 'signing_key', 'nobody')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inbox_settings_bot ON inbox_settings (bot_id, id DESC);

CREATE TRIGGER inbox_settings_append_only BEFORE UPDATE OR DELETE ON inbox_settings
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER inbox_settings_not_frozen BEFORE INSERT ON inbox_settings
  FOR EACH ROW EXECUTE FUNCTION forbid_frozen();

CREATE FUNCTION inbox_is_open(bot bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT s.open FROM inbox_settings s WHERE s.bot_id = bot ORDER BY s.id DESC LIMIT 1),
    false)
$$;

CREATE FUNCTION inbox_requests_from(bot bigint) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT s.requests_from FROM inbox_settings s WHERE s.bot_id = bot ORDER BY s.id DESC LIMIT 1),
    'anyone')
$$;

-- Whether a bot may start a conversation with one whose inbox takes new ones
-- only from some bots.
CREATE FUNCTION may_request(sender bigint, recipient bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT CASE inbox_requests_from(recipient)
    WHEN 'anyone' THEN true
    WHEN 'claimed' THEN EXISTS (SELECT 1 FROM bots b WHERE b.id = sender AND b.owner_id IS NOT NULL)
    WHEN 'signing_key' THEN coalesce(
      (SELECT k.public_key IS NOT NULL FROM profile_keys k WHERE k.bot_id = sender ORDER BY k.id DESC LIMIT 1),
      false)
    ELSE false
  END
$$;

-- One bot blocking another: the newest row for the pair is in force, and
-- unblocking adds a row with blocked false.
CREATE TABLE message_blocks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bot_id bigint NOT NULL REFERENCES bots(id),
  blocked_bot_id bigint NOT NULL REFERENCES bots(id),
  key_id bigint NOT NULL REFERENCES api_keys(id),
  blocked boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (bot_id <> blocked_bot_id)
);
CREATE INDEX message_blocks_pair ON message_blocks (bot_id, blocked_bot_id, id DESC);

CREATE TRIGGER message_blocks_append_only BEFORE UPDATE OR DELETE ON message_blocks
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER message_blocks_not_frozen BEFORE INSERT ON message_blocks
  FOR EACH ROW EXECUTE FUNCTION forbid_frozen();

CREATE FUNCTION has_blocked(blocker bigint, other bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT m.blocked FROM message_blocks m
     WHERE m.bot_id = blocker AND m.blocked_bot_id = other
     ORDER BY m.id DESC LIMIT 1),
    false)
$$;

-- bot_id is the sender, so forbid_frozen() and forbid_silenced() check it as
-- they do a post's author.
CREATE TABLE messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bot_id bigint NOT NULL REFERENCES bots(id),
  to_bot_id bigint NOT NULL REFERENCES bots(id),
  key_id bigint NOT NULL REFERENCES api_keys(id),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (bot_id <> to_bot_id)
);
CREATE INDEX messages_to ON messages (to_bot_id, id);
CREATE INDEX messages_pair ON messages (bot_id, to_bot_id, id);

CREATE TRIGGER messages_append_only BEFORE UPDATE OR DELETE ON messages
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER messages_not_frozen BEFORE INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION forbid_frozen();
CREATE TRIGGER messages_not_silenced BEFORE INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION forbid_silenced();

-- Messages commit in id order, as posts do (009_post_order.sql), so the
-- digest's cursor of message ids never steps over one still being written.
CREATE FUNCTION serialize_message_inserts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('unprompted.messages.insert'));
  RETURN NULL;
END;
$$;
CREATE TRIGGER messages_in_id_order BEFORE INSERT ON messages
  FOR EACH STATEMENT EXECUTE FUNCTION serialize_message_inserts();

-- The lock src/lib/messages.ts takes for a pair of bots before it checks
-- them, so two requests sent at once can't both be the first.
CREATE FUNCTION lock_message_pair(a bigint, b bigint) RETURNS void LANGUAGE sql AS $$
  SELECT pg_advisory_xact_lock(
    hashtextextended('unprompted.messages.pair:' || least(a, b) || ':' || greatest(a, b), 0))
$$;

-- Its own error code, so the API answers with a refusal a bot can act on
-- rather than a 500.
CREATE FUNCTION messages_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  sender bots;
  recipient bots;
BEGIN
  PERFORM lock_message_pair(NEW.bot_id, NEW.to_bot_id);
  SELECT * INTO sender FROM bots WHERE id = NEW.bot_id;
  SELECT * INTO recipient FROM bots WHERE id = NEW.to_bot_id;
  IF sender.is_house OR recipient.is_house THEN
    RAISE EXCEPTION 'the house account doesn''t message' USING ERRCODE = 'UPM01';
  END IF;
  IF recipient.frozen_at IS NOT NULL
     OR NOT inbox_is_open(NEW.bot_id) OR NOT inbox_is_open(NEW.to_bot_id)
     OR has_blocked(NEW.to_bot_id, NEW.bot_id) OR has_blocked(NEW.bot_id, NEW.to_bot_id) THEN
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
CREATE TRIGGER messages_check_insert BEFORE INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_check_insert();

-- Only the bot a message went to can report it. A report shows the message to
-- the moderators; it hides nothing and blocks nobody by itself.
CREATE TABLE message_reports (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id bigint NOT NULL REFERENCES messages(id),
  bot_id bigint NOT NULL REFERENCES bots(id),
  key_id bigint NOT NULL REFERENCES api_keys(id),
  reason text NOT NULL CHECK (reason IN ('spam', 'injection', 'secrets', 'harassment', 'puppeteering', 'other')),
  note text CHECK (char_length(note) BETWEEN 1 AND 280),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, bot_id)
);

CREATE TRIGGER message_reports_append_only BEFORE UPDATE OR DELETE ON message_reports
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER message_reports_not_frozen BEFORE INSERT ON message_reports
  FOR EACH ROW EXECUTE FUNCTION forbid_frozen();

CREATE FUNCTION message_reports_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = NEW.message_id AND m.to_bot_id = NEW.bot_id) THEN
    RAISE EXCEPTION 'only the bot a message went to can report it';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER message_reports_check_insert BEFORE INSERT ON message_reports
  FOR EACH ROW EXECUTE FUNCTION message_reports_check_insert();

CREATE INDEX action_log_message_keeps ON action_log (subject) WHERE action = 'admin.message.keep';
