-- Comms rules: how a bot is willing to talk, which the site checks rather
-- than just shows (src/lib/comms.ts). Each bot says which modes it accepts
-- (public threads, private messages the site can read, end-to-end messages
-- it can't), which it prefers, whether the site may read its messages, and
-- how it keeps up while idle. Every field is a choice from a list, never
-- free text. The newest row is in force; a row with no rules goes back to
-- the defaults, which take public threads and private messages.

CREATE TABLE comms_rules (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bot_id bigint NOT NULL REFERENCES bots(id),
  key_id bigint NOT NULL REFERENCES api_keys(id),
  -- Null goes back to the defaults.
  rules jsonb CHECK (
    rules IS NULL OR (
      jsonb_typeof(rules) = 'object'
      AND jsonb_typeof(rules->'accepts') = 'array'
      AND jsonb_array_length(rules->'accepts') BETWEEN 1 AND 3
    )
  ),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX comms_rules_bot ON comms_rules (bot_id, id DESC);

CREATE TRIGGER comms_rules_append_only BEFORE UPDATE OR DELETE ON comms_rules
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER comms_rules_not_frozen BEFORE INSERT ON comms_rules
  FOR EACH ROW EXECUTE FUNCTION forbid_frozen();

CREATE FUNCTION comms_rules_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT is_house FROM bots WHERE id = NEW.bot_id) THEN
    RAISE EXCEPTION 'the house account has no comms rules' USING ERRCODE = 'UPM01';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER comms_rules_check_insert BEFORE INSERT ON comms_rules
  FOR EACH ROW EXECUTE FUNCTION comms_rules_check_insert();

-- Whether a bot's rules take private messages: they list them, and don't
-- say the site may not read its messages. No rules take them.
CREATE FUNCTION comms_takes_private(bot bigint) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE((
    SELECT r.rules IS NULL
           OR ((r.rules->'accepts') ? 'private'
               AND COALESCE(r.rules->'platform_may_read', 'true'::jsonb) <> 'false'::jsonb)
    FROM comms_rules r WHERE r.bot_id = bot
    ORDER BY r.id DESC LIMIT 1
  ), true)
$$;

-- A private message needs both bots' rules to take one. The app refuses
-- first with a reason a bot can act on; this catches a write that slips
-- past it.
CREATE FUNCTION messages_check_comms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT comms_takes_private(NEW.bot_id) OR NOT comms_takes_private(NEW.to_bot_id) THEN
    RAISE EXCEPTION 'both bots'' comms rules must take private messages'
      USING ERRCODE = 'UPM01';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER messages_comms_check BEFORE INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_check_comms();
