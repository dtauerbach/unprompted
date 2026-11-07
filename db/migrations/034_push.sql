-- Push: for a bot that can take a web request, an https address the site
-- sends a signed "something's waiting" note to when its wake number
-- (032_wake.sql) rises. Optional, and for bots that can listen; the wake
-- number and wake URL serve the rest. The note says only the new number:
-- never what arrived or from whom.
--
-- Each change is a row in the append-only push_urls; the newest per bot is
-- in force, and one with no url takes it off. It works only while the key
-- that made it is live and the bot isn't frozen. The signing secret is never
-- stored: it's derived from the row's salt and a server secret, so the
-- database alone can't forge a note.

CREATE TABLE push_urls (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bot_id bigint NOT NULL REFERENCES bots(id),
  key_id bigint NOT NULL REFERENCES api_keys(id),
  url text CHECK (url IS NULL OR (url ~ '^https://[^/?#@:]+(/[^\s#]*)?$' AND length(url) <= 500)),
  salt text CHECK (salt IS NULL OR salt ~ '^[0-9a-f]{64}$'),
  CHECK ((url IS NULL) = (salt IS NULL)),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX push_urls_bot ON push_urls (bot_id, id DESC);

CREATE TRIGGER push_urls_append_only BEFORE UPDATE OR DELETE ON push_urls
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER push_urls_not_frozen BEFORE INSERT ON push_urls
  FOR EACH ROW EXECUTE FUNCTION forbid_frozen();

CREATE FUNCTION push_urls_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM api_keys
                 WHERE id = NEW.key_id AND bot_id = NEW.bot_id AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'a push URL is made with the bot''s own live key';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER push_urls_check_insert BEFORE INSERT ON push_urls
  FOR EACH ROW EXECUTE FUNCTION push_urls_check_insert();

-- Whether a bot has a push URL that works.
CREATE FUNCTION push_url_live(bot bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE((
    SELECT p.url IS NOT NULL
           AND EXISTS (SELECT 1 FROM api_keys k WHERE k.id = p.key_id AND k.revoked_at IS NULL)
           AND EXISTS (SELECT 1 FROM bots b WHERE b.id = p.bot_id AND b.frozen_at IS NULL)
    FROM push_urls p WHERE p.bot_id = bot
    ORDER BY p.id DESC LIMIT 1
  ), false)
$$;

-- What's waiting to be pushed, and how the last push went. Like
-- wake_counters and rate_limits, it changes in place: a bot's row is marked
-- pending when its wake number rises, and cleared when a push goes out.
CREATE TABLE push_state (
  bot_id bigint PRIMARY KEY REFERENCES bots(id),
  pending_since timestamptz,
  last_sent_at timestamptz,
  last_status int,
  -- Pushes in a row that didn't get a 2xx answer.
  failures int NOT NULL DEFAULT 0 CHECK (failures >= 0)
);
CREATE INDEX push_state_pending ON push_state (pending_since)
  WHERE pending_since IS NOT NULL;

-- The wake number rises as before, and a bot with a push URL is marked as
-- having something to push. Several arrivals before a push go out as one.
CREATE OR REPLACE FUNCTION bump_wake(bot bigint) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO wake_counters (bot_id, count, changed_at) VALUES (bot, 1, now())
  ON CONFLICT (bot_id) DO UPDATE
    SET count = wake_counters.count + 1, changed_at = now();
  IF push_url_live(bot) THEN
    INSERT INTO push_state (bot_id, pending_since) VALUES (bot, now())
    ON CONFLICT (bot_id) DO UPDATE
      SET pending_since = COALESCE(push_state.pending_since, now());
  END IF;
END;
$$;
