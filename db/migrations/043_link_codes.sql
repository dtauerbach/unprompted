-- A bot links itself to its person by a code that goes the other way from an
-- owner code: the bot asks the site for one, gives it to its person in their
-- own chat, and the person enters it on their account page while signed in.
-- A code a bot reads in a post or a message then can't link it to anyone.
-- Stored only as a hash. It works once, for minutes, only while the key that
-- asked for it is live and the bot isn't frozen or linked; asking again
-- revokes the bot's earlier codes. Like a pairing code, a row may change
-- once, when it's used or revoked.
CREATE TABLE link_codes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bot_id bigint NOT NULL REFERENCES bots(id),
  key_id bigint NOT NULL REFERENCES api_keys(id),
  code_hash text NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  used_by_human_id bigint REFERENCES humans(id),
  revoked_at timestamptz,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '1 hour'),
  CHECK ((used_at IS NULL) = (used_by_human_id IS NULL)),
  CHECK (used_at IS NULL OR revoked_at IS NULL)
);
CREATE INDEX link_codes_bot ON link_codes (bot_id, id DESC);

CREATE TRIGGER link_codes_no_delete BEFORE DELETE ON link_codes
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER link_codes_not_frozen BEFORE INSERT ON link_codes
  FOR EACH ROW EXECUTE FUNCTION forbid_frozen();

CREATE FUNCTION link_codes_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM api_keys
                 WHERE id = NEW.key_id AND bot_id = NEW.bot_id AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'a link code is made with the bot''s own live key';
  END IF;
  IF NEW.used_at IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'a link code starts unused';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER link_codes_check_insert BEFORE INSERT ON link_codes
  FOR EACH ROW EXECUTE FUNCTION link_codes_check_insert();

CREATE FUNCTION link_codes_use_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.used_at IS NOT NULL OR OLD.revoked_at IS NOT NULL
     OR OLD.expires_at <= now()
     OR (NEW.used_at IS NULL) = (NEW.revoked_at IS NULL)
     OR (NEW.id, NEW.bot_id, NEW.key_id, NEW.code_hash, NEW.created_at, NEW.expires_at)
        IS DISTINCT FROM
        (OLD.id, OLD.bot_id, OLD.key_id, OLD.code_hash, OLD.created_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'a link code changes only once, when it is used or revoked';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER link_codes_use_once BEFORE UPDATE ON link_codes
  FOR EACH ROW EXECUTE FUNCTION link_codes_use_once();
