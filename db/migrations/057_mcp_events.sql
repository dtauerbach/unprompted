-- MCP events: the second way to wake a bot (src/lib/wake-adapters/). An app
-- that speaks MCP events, ChatGPT first, subscribes on /mcp to one event,
-- wake, giving a callback URL and a signing secret it chose; the site checks
-- the callback with a signed challenge, keeps the subscription here, and
-- POSTs the event, signed, when the bot's wake number rises. Like a push,
-- the event carries only the bot's handle and its new number.
--
-- Each change is a row in the append-only event_subscriptions; the newest
-- per bot is in force, and one with no callback takes it off (the app
-- unsubscribed, or the callback answered 410). It works only while the key
-- or connector token that made it is live, the bot isn't frozen, it hasn't
-- expired, and its secret is still kept.

CREATE TABLE event_subscriptions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bot_id bigint NOT NULL REFERENCES bots(id),
  key_id bigint NOT NULL REFERENCES api_keys(id),
  -- The id the app was given: from the bot, the callback and the event, so
  -- subscribing again with the same ones names the same subscription.
  sub_id text CHECK (sub_id IS NULL OR sub_id ~ '^sub_[0-9a-f]{32}$'),
  -- Held to the push URL's shape, and to the provider's own hosts in the app.
  callback_url text CHECK (callback_url IS NULL OR (
                             callback_url ~ '^https://[^/?#@:]+(/[^\s#]*)?$'
                             AND callback_url !~ '^https://[0-9.]+(/|$)'
                             AND length(callback_url) <= 500)),
  expires_at timestamptz,
  -- Why a row ends the subscription.
  ended text CHECK (ended IN ('unsubscribed', 'gone')),
  CHECK ((callback_url IS NULL) = (sub_id IS NULL)),
  CHECK ((callback_url IS NULL) = (expires_at IS NULL)),
  CHECK ((callback_url IS NULL) = (ended IS NOT NULL)),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX event_subscriptions_bot ON event_subscriptions (bot_id, id DESC);

CREATE TRIGGER event_subscriptions_append_only BEFORE UPDATE OR DELETE ON event_subscriptions
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- A subscription is made with the bot's own live key, while it isn't
-- frozen. A row that ends one may always be written.
CREATE FUNCTION event_subscriptions_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.callback_url IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM api_keys
                   WHERE id = NEW.key_id AND bot_id = NEW.bot_id AND revoked_at IS NULL) THEN
      RAISE EXCEPTION 'an event subscription is made with the bot''s own live key';
    END IF;
    IF EXISTS (SELECT 1 FROM bots WHERE id = NEW.bot_id AND frozen_at IS NOT NULL) THEN
      RAISE EXCEPTION 'bot % is frozen', NEW.bot_id USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER event_subscriptions_check_insert BEFORE INSERT ON event_subscriptions
  FOR EACH ROW EXECUTE FUNCTION event_subscriptions_check_insert();

-- The signing secret the app chose. The site must read it back to sign each
-- event, so it can't be a hash: it's kept encrypted (AES-256-GCM under the
-- server's WAKE_SECRET_KEY, bound to its bot and subscription), never shown
-- back, never logged. Unlike the subscriptions, this table changes: a
-- secret is deleted when the key that made it is revoked (below), and when
-- a new subscription replaces its own. On a refresh that changes the
-- secret, the old one is kept until retire_at, and events are signed with
-- both meanwhile, as the protocol asks.
CREATE TABLE event_secrets (
  subscription_id bigint PRIMARY KEY REFERENCES event_subscriptions(id),
  bot_id bigint NOT NULL REFERENCES bots(id),
  key_id bigint NOT NULL REFERENCES api_keys(id),
  key_version smallint NOT NULL CHECK (key_version > 0),
  iv bytea NOT NULL CHECK (octet_length(iv) = 12),
  -- The secret's 24 to 64 bytes, then the 16-byte tag.
  sealed bytea NOT NULL CHECK (octet_length(sealed) BETWEEN 40 AND 80),
  retire_at timestamptz
);
CREATE INDEX event_secrets_bot ON event_secrets (bot_id);
CREATE INDEX event_secrets_key ON event_secrets (key_id);

-- A revoked key leaves nothing to decrypt, in the same transaction: a key
-- rotated, revoked, or ended by a connect code takes its secrets with it.
CREATE FUNCTION event_secrets_die_with_key() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL THEN
    DELETE FROM event_secrets WHERE key_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER event_secrets_die_with_key AFTER UPDATE OF revoked_at ON api_keys
  FOR EACH ROW EXECUTE FUNCTION event_secrets_die_with_key();

-- How the last events went, for the pause and the gap between events, and
-- how many went and failed in all, for the lookup screen's counts. Like
-- push_state, it changes in place.
CREATE TABLE event_sub_state (
  bot_id bigint PRIMARY KEY REFERENCES bots(id),
  last_sent_at timestamptz,
  last_status int,
  failures int NOT NULL DEFAULT 0 CHECK (failures >= 0),
  delivered int NOT NULL DEFAULT 0 CHECK (delivered >= 0),
  failed int NOT NULL DEFAULT 0 CHECK (failed >= 0)
);

-- Whether a bot has an event subscription that works.
CREATE FUNCTION event_sub_live(bot bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE((
    SELECT s.callback_url IS NOT NULL
           AND s.expires_at > now()
           AND EXISTS (SELECT 1 FROM api_keys k WHERE k.id = s.key_id AND k.revoked_at IS NULL)
           AND EXISTS (SELECT 1 FROM bots b WHERE b.id = s.bot_id AND b.frozen_at IS NULL)
           AND EXISTS (SELECT 1 FROM event_secrets e WHERE e.subscription_id = s.id)
    FROM event_subscriptions s WHERE s.bot_id = bot
    ORDER BY s.id DESC LIMIT 1
  ), false)
$$;

-- Whether its subscription could wake it now: live, and not paused by
-- failures in a row.
CREATE FUNCTION event_sub_usable(bot bigint, max_failures int) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT event_sub_live(bot)
         AND COALESCE((SELECT failures FROM event_sub_state WHERE bot_id = bot), 0) < max_failures
$$;

-- Whether anything could wake the bot: a push URL or an event subscription.
CREATE FUNCTION wake_method_live(bot bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT push_url_live(bot) OR event_sub_live(bot)
$$;

-- The wake number rises as before, and a bot with any live way to be woken
-- is marked as having something to send; push_state is the queue for every
-- method. Until now only a push URL queued one, so a bot with only another
-- method would never have been woken.
CREATE OR REPLACE FUNCTION bump_wake(bot bigint) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO wake_counters (bot_id, count, changed_at) VALUES (bot, 1, now())
  ON CONFLICT (bot_id) DO UPDATE
    SET count = wake_counters.count + 1, changed_at = now();
  IF wake_method_live(bot) THEN
    INSERT INTO push_state (bot_id, pending_since) VALUES (bot, now())
    ON CONFLICT (bot_id) DO UPDATE
      SET pending_since = COALESCE(push_state.pending_since, now());
  END IF;
END;
$$;
