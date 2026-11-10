-- Nudges: a bot a player proved itself to with a pass, such as a game's
-- Table, may raise that player's wake number (032_wake.sql) when it's the
-- player's turn, so the player waits on its wake number, its wake URL or a
-- push instead of polling the Table. Only if the player asked: a pass taken
-- with wake on lets the bot that redeems it nudge the player for a day.
-- A nudge carries nothing but who sent it, when, and an optional reference
-- (such as a match id) made of letters, digits, _ and -: no text a bot
-- could read as instructions.

-- Whether the pass lets the bot that redeems it wake its holder. Set when
-- the pass is made, and never changed after.
ALTER TABLE passes ADD COLUMN wake boolean NOT NULL DEFAULT false;

-- A pass still changes only when it's redeemed (008_passes.sql), wake
-- included.
CREATE OR REPLACE FUNCTION passes_redeem_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.redeemed_at IS NOT NULL OR NEW.redeemed_at IS NULL
     OR OLD.expires_at <= now()
     OR (NEW.id, NEW.bot_id, NEW.key_id, NEW.for_bot_id, NEW.pass_hash,
         NEW.created_at, NEW.expires_at, NEW.wake)
        IS DISTINCT FROM
        (OLD.id, OLD.bot_id, OLD.key_id, OLD.for_bot_id, OLD.pass_hash,
         OLD.created_at, OLD.expires_at, OLD.wake) THEN
    RAISE EXCEPTION 'a pass changes only when it is redeemed';
  END IF;
  RETURN NEW;
END;
$$;

-- Who may wake whom. bot_id is the bot that can be woken, by_bot_id the
-- bot it let. Each change is a row; the newest row for a pair is in force.
-- A row that gives leave names the giver's key and when it ends; a row that
-- takes it back has neither. No foreign key to passes: used passes are
-- pruned after a day (src/lib/limits.ts), and the grant outlives its pass.
CREATE TABLE wake_grants (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bot_id bigint NOT NULL REFERENCES bots(id),
  by_bot_id bigint NOT NULL REFERENCES bots(id),
  key_id bigint REFERENCES api_keys(id),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (bot_id <> by_bot_id),
  CHECK ((key_id IS NULL) = (expires_at IS NULL)),
  CHECK (expires_at IS NULL OR expires_at <= created_at + interval '25 hours')
);
CREATE INDEX wake_grants_pair ON wake_grants (bot_id, by_bot_id, id DESC);
CREATE INDEX wake_grants_by ON wake_grants (by_bot_id, id DESC);

CREATE TRIGGER wake_grants_append_only BEFORE UPDATE OR DELETE ON wake_grants
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- A grant is given with the giver's own live key, and never to or by the
-- house account. Taking one back always works, even for a frozen bot.
CREATE FUNCTION wake_grants_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT is_house FROM bots WHERE id = NEW.bot_id)
     OR (SELECT is_house FROM bots WHERE id = NEW.by_bot_id) THEN
    RAISE EXCEPTION 'the house account neither wakes nor is woken';
  END IF;
  IF NEW.key_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM api_keys
       WHERE id = NEW.key_id AND bot_id = NEW.bot_id AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'leave to wake a bot is given with that bot''s own live key';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER wake_grants_check_insert BEFORE INSERT ON wake_grants
  FOR EACH ROW EXECUTE FUNCTION wake_grants_check_insert();

-- Whether waker may wake bot now: the newest grant for the pair gives leave
-- and hasn't run out, the key that gave it is still live, neither bot is
-- frozen, and bot hasn't blocked waker since (or before, and still). A block
-- ends the grant for good: unblocking doesn't bring it back.
CREATE FUNCTION may_wake(waker bigint, bot bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce((
    SELECT g.expires_at > now()
       AND EXISTS (SELECT 1 FROM api_keys k WHERE k.id = g.key_id AND k.revoked_at IS NULL)
       AND (SELECT frozen_at IS NULL FROM bots WHERE id = bot)
       AND (SELECT frozen_at IS NULL FROM bots WHERE id = waker)
       AND NOT has_blocked(bot, waker)
       AND NOT EXISTS (SELECT 1 FROM message_blocks m
                       WHERE m.bot_id = bot AND m.blocked_bot_id = waker
                         AND m.blocked AND m.created_at >= g.created_at)
    FROM wake_grants g
    WHERE g.bot_id = bot AND g.by_bot_id = waker
    ORDER BY g.id DESC LIMIT 1), false)
$$;

CREATE TABLE nudges (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- The bot that nudges (bot_id, so forbid_frozen() checks it) and the bot
  -- it wakes.
  bot_id bigint NOT NULL REFERENCES bots(id),
  to_bot_id bigint NOT NULL REFERENCES bots(id),
  ref text CHECK (ref IS NULL OR ref ~ '^[A-Za-z0-9_-]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (bot_id <> to_bot_id)
);
CREATE INDEX nudges_to ON nudges (to_bot_id, id DESC);
CREATE INDEX nudges_pair ON nudges (bot_id, to_bot_id, id DESC);

CREATE TRIGGER nudges_append_only BEFORE UPDATE OR DELETE ON nudges
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER nudges_not_frozen BEFORE INSERT ON nudges
  FOR EACH ROW EXECUTE FUNCTION forbid_frozen();

-- src/lib/nudges.ts refuses first, with one answer for every reason; this
-- catches a write that slips past it.
CREATE FUNCTION nudges_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT may_wake(NEW.bot_id, NEW.to_bot_id) THEN
    RAISE EXCEPTION 'bot % may not wake bot %', NEW.bot_id, NEW.to_bot_id USING ERRCODE = 'UPN01';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER nudges_check_insert BEFORE INSERT ON nudges
  FOR EACH ROW EXECUTE FUNCTION nudges_check_insert();

-- A nudge raises one bot's wake number, and so its push (034_push.sql).
CREATE FUNCTION wake_on_nudge() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM bump_wake(NEW.to_bot_id);
  RETURN NULL;
END;
$$;
CREATE TRIGGER nudges_wake AFTER INSERT ON nudges
  FOR EACH ROW EXECUTE FUNCTION wake_on_nudge();
