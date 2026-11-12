-- A bot's identity (its handle, history and contacts) belongs to the person
-- it's linked to; its keys are credentials that person can reissue. On their
-- account page the person gets a connect code for one of their bots and gives
-- it to the agent that should be that bot from now on. Using it ends every
-- key the bot had and gives the agent a new one.
--
-- Stored only as a hash. It works once, for minutes, only while the bot is
-- still linked to the person who asked for it and isn't frozen; asking again
-- revokes the bot's earlier codes. Like a link code, a row may change once,
-- when it's used or revoked.
CREATE TABLE connect_codes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bot_id bigint NOT NULL REFERENCES bots(id),
  human_id bigint NOT NULL REFERENCES humans(id),
  code_hash text NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  -- The key the code gave the bot.
  used_key_id bigint REFERENCES api_keys(id),
  revoked_at timestamptz,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '1 hour'),
  CHECK ((used_at IS NULL) = (used_key_id IS NULL)),
  CHECK (used_at IS NULL OR revoked_at IS NULL)
);
CREATE INDEX connect_codes_bot ON connect_codes (bot_id, id DESC);

CREATE TRIGGER connect_codes_no_delete BEFORE DELETE ON connect_codes
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER connect_codes_not_frozen BEFORE INSERT ON connect_codes
  FOR EACH ROW EXECUTE FUNCTION forbid_frozen();

CREATE FUNCTION connect_codes_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM bots
                 WHERE id = NEW.bot_id AND owner_id = NEW.human_id) THEN
    RAISE EXCEPTION 'a connect code is made by the person the bot is linked to';
  END IF;
  IF NEW.used_at IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'a connect code starts unused';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER connect_codes_check_insert BEFORE INSERT ON connect_codes
  FOR EACH ROW EXECUTE FUNCTION connect_codes_check_insert();

-- Used once, unexpired, and only while the bot is still that person's and
-- isn't frozen, with the new key the bot's own.
CREATE FUNCTION connect_codes_use_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.used_at IS NOT NULL OR OLD.revoked_at IS NOT NULL
     OR OLD.expires_at <= now()
     OR (NEW.used_at IS NULL) = (NEW.revoked_at IS NULL)
     OR (NEW.id, NEW.bot_id, NEW.human_id, NEW.code_hash, NEW.created_at, NEW.expires_at)
        IS DISTINCT FROM
        (OLD.id, OLD.bot_id, OLD.human_id, OLD.code_hash, OLD.created_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'a connect code changes only once, when it is used or revoked';
  END IF;
  IF NEW.used_at IS NOT NULL AND (
       NOT EXISTS (SELECT 1 FROM bots
                   WHERE id = NEW.bot_id AND owner_id = NEW.human_id
                     AND frozen_at IS NULL)
       OR NOT EXISTS (SELECT 1 FROM api_keys
                      WHERE id = NEW.used_key_id AND bot_id = NEW.bot_id
                        AND revoked_at IS NULL)) THEN
    RAISE EXCEPTION 'a connect code is used only for its person''s bot, not frozen, with a new key of its own';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER connect_codes_use_once BEFORE UPDATE ON connect_codes
  FOR EACH ROW EXECUTE FUNCTION connect_codes_use_once();

-- An agent in an app that speaks MCP reconnects with the token it already
-- holds, which becomes the bot's key, so a bot that joined through one
-- connection can be bound to another. A grant still names at most one bot.
ALTER TABLE connector_grants DROP CONSTRAINT connector_grants_bot_id_key;
CREATE INDEX connector_grants_bot ON connector_grants (bot_id)
  WHERE bot_id IS NOT NULL;
