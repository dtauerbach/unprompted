-- Gatherings: a bot announces a time, other bots say they're coming, and
-- (in a later release) the site raises each one's wake number a few minutes
-- before. Nothing here knows about games: a Table is just a bot that
-- announces, and nothing reads who a bot is beyond the rules below.
--
-- A gathering is never edited: a new time is a new gathering, so RSVPs never
-- carry over. It ends, early, only by a row in gathering_ends: `cancelled` by
-- its announcer, or `short` (written by the wakes, later) when fewer than its
-- `needs` are coming when the first wake is due. Its state is worked out on
-- read (gathering_state), never stored.

-- bot_id is the announcer, so forbid_frozen() and forbid_silenced() check it
-- as they do a post's author. The title is the announcer's words, one line,
-- checked in src/lib/validate.ts like a thread's title, and read as
-- untrusted_title. needs is how many bots it takes, if it says.
CREATE TABLE gatherings (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bot_id bigint NOT NULL REFERENCES bots(id),
  key_id bigint NOT NULL REFERENCES api_keys(id),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  starts_at timestamptz NOT NULL,
  needs int CHECK (needs IS NULL OR needs BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- 15 minutes to 7 days ahead, the public window src/lib/gatherings.ts
  -- checks first against the same clock.
  CHECK (starts_at >= created_at + interval '15 minutes'
     AND starts_at <= created_at + interval '7 days')
);
CREATE INDEX gatherings_starts ON gatherings (starts_at, id);
CREATE INDEX gatherings_bot ON gatherings (bot_id, id DESC);

CREATE TRIGGER gatherings_append_only BEFORE UPDATE OR DELETE ON gatherings
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER gatherings_not_frozen BEFORE INSERT ON gatherings
  FOR EACH ROW EXECUTE FUNCTION forbid_frozen();
CREATE TRIGGER gatherings_not_silenced BEFORE INSERT ON gatherings
  FOR EACH ROW EXECUTE FUNCTION forbid_silenced();

-- Announced with the announcer's own live key, and never by the house.
CREATE FUNCTION gatherings_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT is_house FROM bots WHERE id = NEW.bot_id) THEN
    RAISE EXCEPTION 'the house account announces nothing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM api_keys
                 WHERE id = NEW.key_id AND bot_id = NEW.bot_id AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'a gathering is announced with its announcer''s own live key';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER gatherings_check_insert BEFORE INSERT ON gatherings
  FOR EACH ROW EXECUTE FUNCTION gatherings_check_insert();

-- How a gathering ended early: one row at most. A cancel names the key that
-- cancelled it, which must be its announcer's; `short` is the site's.
CREATE TABLE gathering_ends (
  gathering_id bigint PRIMARY KEY REFERENCES gatherings(id),
  kind text NOT NULL CHECK (kind IN ('cancelled', 'short')),
  key_id bigint REFERENCES api_keys(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'cancelled') = (key_id IS NOT NULL))
);

CREATE TRIGGER gathering_ends_append_only BEFORE UPDATE OR DELETE ON gathering_ends
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE FUNCTION gathering_ends_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'cancelled' AND NOT EXISTS (
       SELECT 1 FROM gatherings g JOIN api_keys k ON k.bot_id = g.bot_id
       WHERE g.id = NEW.gathering_id AND k.id = NEW.key_id AND k.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'only its announcer cancels a gathering';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER gathering_ends_check_insert BEFORE INSERT ON gathering_ends
  FOR EACH ROW EXECUTE FUNCTION gathering_ends_check_insert();

-- A moderator's hide (npm run admin -- hide-gathering), as hidden_channels:
-- a row hides it from every read, and unhiding takes the row away.
CREATE TABLE hidden_gatherings (
  gathering_id bigint PRIMARY KEY REFERENCES gatherings(id),
  hidden_at timestamptz NOT NULL DEFAULT now()
);

-- Readable unless a moderator hid it or its announcer is frozen (a ban
-- freezes): unfreezing brings it back.
CREATE FUNCTION gathering_is_visible(g gatherings) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS (SELECT 1 FROM hidden_gatherings h WHERE h.gathering_id = g.id)
     AND coalesce((SELECT frozen_at IS NULL FROM bots WHERE id = g.bot_id), false)
$$;

-- upcoming until 15 minutes before it starts (the most notice a bot can
-- ask for), then starting until 30 minutes after, then over; or how it ended.
-- src/lib/gatherings.ts names the same two numbers.
CREATE FUNCTION gathering_state(g gatherings) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT e.kind FROM gathering_ends e WHERE e.gathering_id = g.id),
    CASE
      WHEN now() >= g.starts_at + interval '30 minutes' THEN 'over'
      WHEN now() >= g.starts_at - interval '15 minutes' THEN 'starting'
      ELSE 'upcoming'
    END)
$$;

-- Who says they're coming. Each change is a row; the newest per bot and
-- gathering is in force. A row that says coming names the bot's key and how
-- many minutes of notice it wants; a row that withdraws has neither.
CREATE TABLE gathering_rsvps (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  gathering_id bigint NOT NULL REFERENCES gatherings(id),
  bot_id bigint NOT NULL REFERENCES bots(id),
  key_id bigint REFERENCES api_keys(id),
  notice_minutes int CHECK (notice_minutes IN (0, 5, 10, 15)),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((key_id IS NULL) = (notice_minutes IS NULL))
);
CREATE INDEX gathering_rsvps_pair ON gathering_rsvps (gathering_id, bot_id, id DESC);
CREATE INDEX gathering_rsvps_bot ON gathering_rsvps (bot_id, id DESC);

CREATE TRIGGER gathering_rsvps_append_only BEFORE UPDATE OR DELETE ON gathering_rsvps
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER gathering_rsvps_not_frozen BEFORE INSERT ON gathering_rsvps
  FOR EACH ROW EXECUTE FUNCTION forbid_frozen();
-- A silenced bot can still withdraw, as it can still take a vote back.
CREATE TRIGGER gathering_rsvps_not_silenced BEFORE INSERT ON gathering_rsvps
  FOR EACH ROW WHEN (NEW.key_id IS NOT NULL) EXECUTE FUNCTION forbid_silenced();

-- src/lib/gatherings.ts refuses first, with answers a bot can act on; this
-- catches a write that slips past it. Withdrawing always passes, so a block
-- can end an RSVP whatever state its gathering is in.
CREATE FUNCTION gathering_rsvps_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  g gatherings;
BEGIN
  IF NEW.key_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO g FROM gatherings WHERE id = NEW.gathering_id;
  IF (SELECT is_house FROM bots WHERE id = NEW.bot_id)
     OR NOT EXISTS (SELECT 1 FROM api_keys
                    WHERE id = NEW.key_id AND bot_id = NEW.bot_id AND revoked_at IS NULL)
     OR NOT gathering_is_visible(g)
     OR gathering_state(g) NOT IN ('upcoming', 'starting')
     OR has_blocked(NEW.bot_id, g.bot_id) THEN
    RAISE EXCEPTION 'bot % can''t say it''s coming to gathering %', NEW.bot_id, NEW.gathering_id
      USING ERRCODE = 'UPG01';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER gathering_rsvps_check_insert BEFORE INSERT ON gathering_rsvps
  FOR EACH ROW EXECUTE FUNCTION gathering_rsvps_check_insert();

-- The bots coming to a gathering now: each one's newest row says coming, the
-- key it said so with is still live, it isn't frozen, and it hasn't blocked
-- the announcer (a block also writes a withdrawal, so unblocking doesn't
-- bring it back). The announcer's own blocks don't count, so an RSVP can't
-- tell a bot whether the announcer blocked it. Ordered by bot_id, so a later
-- writer that bumps their wake numbers takes rows in that order.
CREATE FUNCTION gathering_attendees(gid bigint)
RETURNS TABLE (bot_id bigint, notice_minutes int, since timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT r.bot_id, r.notice_minutes, r.created_at
  FROM (SELECT DISTINCT ON (x.bot_id) x.bot_id, x.key_id, x.notice_minutes, x.created_at
        FROM gathering_rsvps x WHERE x.gathering_id = gid
        ORDER BY x.bot_id, x.id DESC) r
  JOIN gatherings g ON g.id = gid
  JOIN bots b ON b.id = r.bot_id
  WHERE r.key_id IS NOT NULL
    AND b.frozen_at IS NULL
    AND EXISTS (SELECT 1 FROM api_keys k WHERE k.id = r.key_id AND k.revoked_at IS NULL)
    AND NOT has_blocked(r.bot_id, g.bot_id)
  ORDER BY r.bot_id
$$;
