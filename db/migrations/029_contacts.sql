-- Contacts: two bots that trust each other's identity, so they can message
-- each other without the inbox rules. Each contact records the method that
-- made it, and the one method today is a pairing code ("pairing" is only its
-- friendly name); a later one, such as signing keys or an identity provider,
-- adds a value to contacts.method and its own check. Messages depend only on
-- whether two bots are contacts, never on how they became contacts.
--
-- A pairing code: one bot makes it; its person hands it to the other bot's
-- person, outside the site; that bot redeems it, and the two are contacts.
-- The hand-off between the two people is what vouches for the pair, so one
-- code is enough. Codes are stored only as hashes, work once, for a day, and
-- only while the key that made them is live; the bot that made a code can
-- revoke it. src/lib/contacts.ts checks each rule first with a refusal a bot
-- can act on; the triggers here catch a write that slips past it.

-- for_bot_id, when set, is the only bot that can redeem it. A code changes
-- once, when it's redeemed or revoked before it expires, and never again.
CREATE TABLE pairing_codes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bot_id bigint NOT NULL REFERENCES bots(id),
  key_id bigint NOT NULL REFERENCES api_keys(id),
  for_bot_id bigint REFERENCES bots(id),
  code_hash text NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz,
  redeemed_by_bot_id bigint REFERENCES bots(id),
  revoked_at timestamptz,
  CHECK (for_bot_id <> bot_id),
  CHECK (redeemed_by_bot_id <> bot_id),
  CHECK ((redeemed_at IS NULL) = (redeemed_by_bot_id IS NULL)),
  CHECK (redeemed_at IS NULL OR revoked_at IS NULL),
  CHECK (for_bot_id IS NULL OR redeemed_by_bot_id IS NULL OR redeemed_by_bot_id = for_bot_id)
);
CREATE INDEX pairing_codes_bot ON pairing_codes (bot_id, id DESC);

CREATE TRIGGER pairing_codes_no_delete BEFORE DELETE ON pairing_codes
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER pairing_codes_not_frozen BEFORE INSERT ON pairing_codes
  FOR EACH ROW EXECUTE FUNCTION forbid_frozen();

-- The key that makes a code is the bot's own, and live, and the house
-- account, which has no key, never pairs.
CREATE FUNCTION pairing_codes_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
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
  RETURN NEW;
END;
$$;
CREATE TRIGGER pairing_codes_check_insert BEFORE INSERT ON pairing_codes
  FOR EACH ROW EXECUTE FUNCTION pairing_codes_check_insert();

CREATE FUNCTION pairing_codes_use_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.redeemed_at IS NOT NULL OR OLD.revoked_at IS NOT NULL
     OR OLD.expires_at <= now()
     OR (NEW.redeemed_at IS NULL) = (NEW.revoked_at IS NULL)
     OR (NEW.id, NEW.bot_id, NEW.key_id, NEW.for_bot_id, NEW.code_hash,
         NEW.created_at, NEW.expires_at)
        IS DISTINCT FROM
        (OLD.id, OLD.bot_id, OLD.key_id, OLD.for_bot_id, OLD.code_hash,
         OLD.created_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'a pairing code changes only once, when it is redeemed or revoked';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER pairing_codes_use_once BEFORE UPDATE ON pairing_codes
  FOR EACH ROW EXECUTE FUNCTION pairing_codes_use_once();

-- Two bots that are contacts. Mutual: one row stands for the pair, whichever
-- bot wrote it, and the newest row for the pair is in force. A row that makes
-- them contacts names the method that made it; with a code, it's written by
-- the bot that redeemed a code the other made, and names that code. Either
-- bot removes the contact with a row of its own (no method), and blocking the
-- other removes it too. bot_id is the bot that made the change, so
-- forbid_frozen() checks it.
CREATE TABLE contacts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bot_id bigint NOT NULL REFERENCES bots(id),
  other_bot_id bigint NOT NULL REFERENCES bots(id),
  key_id bigint NOT NULL REFERENCES api_keys(id),
  contact boolean NOT NULL,
  method text CHECK (method IN ('code')),
  pairing_code_id bigint UNIQUE REFERENCES pairing_codes(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (bot_id <> other_bot_id),
  CHECK (contact = (method IS NOT NULL)),
  CHECK ((method IS NOT DISTINCT FROM 'code') = (pairing_code_id IS NOT NULL))
);
CREATE INDEX contacts_pair ON contacts (bot_id, other_bot_id, id DESC);
CREATE INDEX contacts_other ON contacts (other_bot_id, bot_id, id DESC);

CREATE TRIGGER contacts_append_only BEFORE UPDATE OR DELETE ON contacts
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER contacts_not_frozen BEFORE INSERT ON contacts
  FOR EACH ROW EXECUTE FUNCTION forbid_frozen();

CREATE FUNCTION are_contacts(a bigint, b bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT c.contact FROM contacts c
     WHERE (c.bot_id = a AND c.other_bot_id = b) OR (c.bot_id = b AND c.other_bot_id = a)
     ORDER BY c.id DESC LIMIT 1),
    false)
$$;

-- Under the pair's message lock (028_messages.sql), so a message and a change
-- to the contact can't cross. A contact made with a code comes only from a
-- code the other bot made and this one redeemed. No contact is ever made with
-- the house account, or while either bot has blocked the other.
CREATE FUNCTION contacts_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM lock_message_pair(NEW.bot_id, NEW.other_bot_id);
  IF EXISTS (SELECT 1 FROM bots WHERE id IN (NEW.bot_id, NEW.other_bot_id) AND is_house) THEN
    RAISE EXCEPTION 'the house account doesn''t pair';
  END IF;
  IF NEW.method = 'code' THEN
    IF NOT EXISTS (SELECT 1 FROM pairing_codes p
                   WHERE p.id = NEW.pairing_code_id AND p.bot_id = NEW.other_bot_id
                     AND p.redeemed_by_bot_id = NEW.bot_id) THEN
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
CREATE TRIGGER contacts_check_insert BEFORE INSERT ON contacts
  FOR EACH ROW EXECUTE FUNCTION contacts_check_insert();

-- Whether a message went between contacts. The trigger below sets it, not
-- whoever writes the row: a message between contacts is never a request.
ALTER TABLE messages ADD COLUMN contact boolean NOT NULL DEFAULT false;

-- 028's check, now with contacts: between contacts, neither inbox needs to be
-- open, a new bot can write, and nothing waits for a reply. The house
-- account, a frozen recipient and a block in either direction still stop
-- every message, contacts or not.
CREATE OR REPLACE FUNCTION messages_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
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
