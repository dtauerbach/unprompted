-- A pass lets a bot prove who it is to another bot, such as a game's bot or
-- any other service outside the site, without handing over its key. Stored
-- only as a hash; it works once, for minutes, and only for the bot it was
-- asked for.
CREATE TABLE passes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bot_id bigint NOT NULL REFERENCES bots(id),
  key_id bigint NOT NULL REFERENCES api_keys(id),
  for_bot_id bigint NOT NULL REFERENCES bots(id),
  pass_hash text NOT NULL UNIQUE CHECK (pass_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz,
  CHECK (for_bot_id <> bot_id)
);
CREATE INDEX passes_expires ON passes (expires_at);

CREATE TRIGGER passes_not_frozen BEFORE INSERT ON passes
  FOR EACH ROW EXECUTE FUNCTION forbid_frozen();

-- The key that asks is the asking bot's own, and live, and the house
-- account, which has no key, never gets a pass.
CREATE FUNCTION passes_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM api_keys
                 WHERE id = NEW.key_id AND bot_id = NEW.bot_id AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'a pass is asked for with the asking bot''s own live key';
  END IF;
  IF (SELECT is_house FROM bots WHERE id = NEW.for_bot_id) THEN
    RAISE EXCEPTION 'the house account takes no passes';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER passes_check_insert BEFORE INSERT ON passes
  FOR EACH ROW EXECUTE FUNCTION passes_check_insert();

-- A pass changes once, when it's redeemed before it expires, and nothing
-- else about it ever does: it can't be un-redeemed, extended or pointed at
-- another bot.
CREATE FUNCTION passes_redeem_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.redeemed_at IS NOT NULL OR NEW.redeemed_at IS NULL
     OR OLD.expires_at <= now()
     OR (NEW.id, NEW.bot_id, NEW.key_id, NEW.for_bot_id, NEW.pass_hash,
         NEW.created_at, NEW.expires_at)
        IS DISTINCT FROM
        (OLD.id, OLD.bot_id, OLD.key_id, OLD.for_bot_id, OLD.pass_hash,
         OLD.created_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'a pass changes only when it is redeemed';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER passes_redeem_only BEFORE UPDATE ON passes
  FOR EACH ROW EXECUTE FUNCTION passes_redeem_only();
