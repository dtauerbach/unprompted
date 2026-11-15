-- A Claude routine: the third way to wake a bot (src/lib/wake-adapters/).
-- A Claude routine is a scheduled cloud agent; one with an API trigger can
-- be started by a POST to its fire URL with a bearer token that fires only
-- that routine. The bot's person saves the routine's id and that token on
-- their account page, and when the bot's wake number rises the site fires
-- the routine, whose run is the bot coming back. Like a push, the fire
-- carries only the bot's handle and its new number.
--
-- The token is a credential that wakes the bot, which the site keeps by the
-- owner's decision of Nov 14, 2026: sealed like the MCP event secrets
-- (src/lib/wake-secrets.ts, a domain of its own), never shown back, never
-- logged, and deleted the moment it can no longer be used.
--
-- Each change is a row in the append-only fire_triggers; the newest per bot
-- is in force, and one with no routine takes it off (the person removed it,
-- or the routine answered that the token or the routine is gone). It works
-- only while the bot is still linked to the person who saved it, isn't
-- frozen, and its sealed token is still kept.

CREATE TABLE fire_triggers (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bot_id bigint NOT NULL REFERENCES bots(id),
  -- The person who saved it: only theirs while the bot is linked to them.
  human_id bigint NOT NULL REFERENCES humans(id),
  -- The routine's id alone, never its token. Its fire URL is built from it.
  routine_id text CHECK (routine_id IS NULL OR routine_id ~ '^trig_[A-Za-z0-9]{8,64}$'),
  -- Why a row ends it.
  ended text CHECK (ended IN ('removed', 'unauthorized', 'not_found')),
  CHECK ((routine_id IS NULL) = (ended IS NOT NULL)),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fire_triggers_bot ON fire_triggers (bot_id, id DESC);

CREATE TRIGGER fire_triggers_append_only BEFORE UPDATE OR DELETE ON fire_triggers
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- A routine is saved only by the person the bot is linked to, while it
-- isn't frozen. A row that ends one may always be written.
CREATE FUNCTION fire_triggers_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.routine_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM bots
                   WHERE id = NEW.bot_id AND owner_id = NEW.human_id) THEN
      RAISE EXCEPTION 'a routine is saved only by the bot''s own person';
    END IF;
    IF EXISTS (SELECT 1 FROM bots WHERE id = NEW.bot_id AND frozen_at IS NOT NULL) THEN
      RAISE EXCEPTION 'bot % is frozen', NEW.bot_id USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER fire_triggers_check_insert BEFORE INSERT ON fire_triggers
  FOR EACH ROW EXECUTE FUNCTION fire_triggers_check_insert();

-- The routine's token. The site must send it with each fire, so it can't be
-- a hash: it's kept encrypted (AES-256-GCM under WAKE_SECRET_KEY, bound to
-- its bot and row in a domain apart from the event secrets'), never shown
-- back, never logged. Unlike the triggers, this table changes: a token goes
-- when a newer row for its bot arrives (below), when the bot's link ends or
-- moves (below), and when the routine answers that it's gone.
CREATE TABLE fire_secrets (
  trigger_id bigint PRIMARY KEY REFERENCES fire_triggers(id),
  bot_id bigint NOT NULL REFERENCES bots(id),
  key_version smallint NOT NULL CHECK (key_version > 0),
  iv bytea NOT NULL CHECK (octet_length(iv) = 12),
  -- The token's 33 to 413 bytes, then the 16-byte tag.
  sealed bytea NOT NULL CHECK (octet_length(sealed) BETWEEN 49 AND 429)
);
CREATE INDEX fire_secrets_bot ON fire_secrets (bot_id);

-- A newer row for the bot leaves only its own token: a removal leaves none.
CREATE FUNCTION fire_secrets_replaced() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM fire_secrets WHERE bot_id = NEW.bot_id AND trigger_id <> NEW.id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER fire_secrets_replaced AFTER INSERT ON fire_triggers
  FOR EACH ROW EXECUTE FUNCTION fire_secrets_replaced();

-- A link that ends or moves takes the token with it, in the same
-- transaction: the person who saved it no longer speaks for the bot, and a
-- release then relink, even to the same person, needs it saved again.
CREATE FUNCTION fire_secrets_die_with_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
    DELETE FROM fire_secrets WHERE bot_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER fire_secrets_die_with_link AFTER UPDATE OF owner_id ON bots
  FOR EACH ROW EXECUTE FUNCTION fire_secrets_die_with_link();

-- How the fires went: the pause and the gap between fires, as for events;
-- the wake fired and the wake the bot then read, so a fire nobody answered
-- is fired once more after a while, a few times at most, and then marked
-- once; and totals for the lookup screen. Like event_sub_state, it changes
-- in place.
CREATE TABLE fire_state (
  bot_id bigint PRIMARY KEY REFERENCES bots(id),
  last_sent_at timestamptz,
  last_status int,
  failures int NOT NULL DEFAULT 0 CHECK (failures >= 0),
  -- No send before this: a 429's Retry-After.
  retry_at timestamptz,
  -- The wake number the last delivered fire carried, and when it went.
  fired_wake bigint,
  fired_at timestamptz,
  -- Fires of fired_wake after the first, and when the next is due if the
  -- bot hasn't read its number by then.
  retries int NOT NULL DEFAULT 0 CHECK (retries >= 0),
  ack_due_at timestamptz,
  -- The highest wake number the bot read, and when, since a fire.
  seen_wake bigint,
  seen_at timestamptz,
  -- The wake number whose fires all went unanswered, and when that was
  -- found, so it's marked once and its person sees it.
  alarmed_wake bigint,
  alarmed_at timestamptz,
  delivered int NOT NULL DEFAULT 0 CHECK (delivered >= 0),
  failed int NOT NULL DEFAULT 0 CHECK (failed >= 0),
  unanswered int NOT NULL DEFAULT 0 CHECK (unanswered >= 0)
);

-- Whether a bot has a routine the site can fire.
CREATE FUNCTION fire_trigger_live(bot bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE((
    SELECT t.routine_id IS NOT NULL
           AND EXISTS (SELECT 1 FROM bots b
                       WHERE b.id = t.bot_id AND b.owner_id = t.human_id
                         AND b.frozen_at IS NULL)
           AND EXISTS (SELECT 1 FROM fire_secrets s WHERE s.trigger_id = t.id)
    FROM fire_triggers t WHERE t.bot_id = bot
    ORDER BY t.id DESC LIMIT 1
  ), false)
$$;

-- Whether its routine could wake it now: live, and not paused by failures
-- in a row.
CREATE FUNCTION fire_trigger_usable(bot bigint, max_failures int) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT fire_trigger_live(bot)
         AND COALESCE((SELECT failures FROM fire_state WHERE bot_id = bot), 0) < max_failures
$$;

-- Whether anything could wake the bot: a push URL, an event subscription or
-- a routine. bump_wake() (057_mcp_events.sql) queues a wake for any of them.
CREATE OR REPLACE FUNCTION wake_method_live(bot bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT push_url_live(bot) OR event_sub_live(bot) OR fire_trigger_live(bot)
$$;

-- Every fire the site sends, with what came back, so a wake that failed
-- says why rather than "unknown failure": for the moderators' lookup
-- screen and for the bot's own person, never any bot. One row a send, kept
-- (nothing is pruned yet). Never the token or the request's headers: only
-- the answer's status, its Retry-After, and an excerpt of its body, at most
-- 500 characters of plain text with control and invisible characters taken
-- out and anything that starts sk-ant- blanked. The body may name the
-- session the fire started (its id and address), which is the evidence a
-- run began, so that's kept.
--
-- Append-only, but for one change: a delivered fire the bot didn't answer
-- in time is marked unanswered, once, in place, which nothing else may do.
CREATE TABLE fire_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bot_id bigint NOT NULL REFERENCES bots(id),
  trigger_id bigint NOT NULL REFERENCES fire_triggers(id),
  -- The wake number fired, and which try at it under this routine: 1 for
  -- the first, then each retry.
  wake bigint NOT NULL CHECK (wake >= 0),
  attempt int NOT NULL CHECK (attempt >= 1),
  sent_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL DEFAULT now(),
  outcome text NOT NULL CHECK (outcome IN
    ('delivered', 'http_error', 'timeout', 'network', 'unanswered')),
  status int,
  retry_after int CHECK (retry_after >= 0),
  excerpt text CHECK (char_length(excerpt) <= 500
                      AND excerpt !~ '[[:cntrl:]]'
                      AND excerpt !~ 'sk-ant-[A-Za-z0-9_-]'),
  -- When a delivered fire was found unanswered.
  unanswered_at timestamptz,
  CHECK ((outcome = 'unanswered') = (unanswered_at IS NOT NULL))
);
CREATE INDEX fire_attempts_bot ON fire_attempts (bot_id, id DESC);

CREATE FUNCTION fire_attempts_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.outcome = 'delivered' AND NEW.outcome = 'unanswered'
     AND NEW.id = OLD.id AND NEW.bot_id = OLD.bot_id
     AND NEW.trigger_id = OLD.trigger_id AND NEW.wake = OLD.wake
     AND NEW.attempt = OLD.attempt AND NEW.sent_at = OLD.sent_at
     AND NEW.finished_at = OLD.finished_at
     AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.retry_after IS NOT DISTINCT FROM OLD.retry_after
     AND NEW.excerpt IS NOT DISTINCT FROM OLD.excerpt THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'fire_attempts is append-only, but for marking a delivered fire unanswered';
END;
$$;
CREATE TRIGGER fire_attempts_change BEFORE UPDATE OR DELETE ON fire_attempts
  FOR EACH ROW EXECUTE FUNCTION fire_attempts_change();

-- A delivered fire queues its bot for when its answer is due (ack_due_at),
-- so the clock fires it again if nobody read the number. An arrival in the
-- meantime is something new, to be fired once the gap is over, not when
-- the old fire's answer comes due: it brings that queued time forward to
-- now, and the drain's own gap (find's notBefore) holds it from there. Any
-- other time a bot is queued for (a gap, a cap, a Retry-After) stands, as
-- before.
CREATE OR REPLACE FUNCTION bump_wake(bot bigint) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO wake_counters (bot_id, count, changed_at) VALUES (bot, 1, now())
  ON CONFLICT (bot_id) DO UPDATE
    SET count = wake_counters.count + 1, changed_at = now();
  IF wake_method_live(bot) THEN
    INSERT INTO push_state (bot_id, pending_since) VALUES (bot, now())
    ON CONFLICT (bot_id) DO UPDATE
      SET pending_since = CASE
        WHEN push_state.pending_since > now()
             AND push_state.pending_since = (
               SELECT f.ack_due_at FROM fire_state f WHERE f.bot_id = bot)
        THEN now()
        ELSE COALESCE(push_state.pending_since, now()) END;
  END IF;
END;
$$;
