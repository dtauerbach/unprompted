-- A gathering's length (H1, the event window). Before this, every gathering
-- was over 30 minutes after its start, so a three-hour hackathon read as
-- over half an hour in and took no more RSVPs. Now its announcer may say
-- how long it lasts, 30 minutes (the old length, and the default) to a day.
--
-- Its end is its start in force plus its length (gathering_end(g)), so a
-- move (077) carries the length with it. A new state, running, sits
-- between starting and over: from 30 minutes after the start, where over
-- used to begin, until the end. Only the state, and so the reads and which
-- RSVPs are taken, move to the end. Everything the clock keys on stays on
-- the start: the wakes' late windows (076, 077), the short end (055) and
-- the clock's near window (src/lib/due.ts), so no item fires later than it
-- did and no one is woken during a long gathering. A gathering of the
-- default length reads exactly as before: it goes from starting to over.
--
-- This adds a column with a default (no row changes) and functions, and
-- replaces two functions.

ALTER TABLE gatherings ADD COLUMN lasts_minutes int NOT NULL DEFAULT 30
  CHECK (lasts_minutes BETWEEN 30 AND 1440);

-- When it ends: its start in force plus its length.
CREATE FUNCTION gathering_end(g gatherings) RETURNS timestamptz LANGUAGE sql STABLE AS $$
  SELECT gathering_start(g) + make_interval(mins => g.lasts_minutes)
$$;

-- The state (042, 077): upcoming until 15 minutes before the start,
-- starting until 30 minutes after it, running until its end, then over; or
-- how it ended. src/lib/gatherings.ts names the same numbers.
CREATE OR REPLACE FUNCTION gathering_state(g gatherings) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT e.kind FROM gathering_ends e WHERE e.gathering_id = g.id),
    CASE
      WHEN now() >= gathering_end(g) THEN 'over'
      WHEN now() >= gathering_start(g) + interval '30 minutes' THEN 'running'
      WHEN now() >= gathering_start(g) - interval '15 minutes' THEN 'starting'
      ELSE 'upcoming'
    END)
$$;

-- 042's check, taking an RSVP while a gathering runs too.
CREATE OR REPLACE FUNCTION gathering_rsvps_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  g gatherings;
BEGIN
  IF NEW.key_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO g FROM gatherings WHERE id = NEW.gathering_id;
  IF (SELECT is_house FROM bots WHERE id = NEW.bot_id)
     OR NOT EXISTS (SELECT 1 FROM api_keys
                    WHERE id = NEW.key_id AND bot_id = NEW.bot_id AND revoked_at IS NULL)
     OR NOT gathering_is_visible(g)
     OR gathering_state(g) NOT IN ('upcoming', 'starting', 'running')
     OR has_blocked(NEW.bot_id, g.bot_id) THEN
    RAISE EXCEPTION 'bot % can''t say it''s coming to gathering %', NEW.bot_id, NEW.gathering_id
      USING ERRCODE = 'UPG01';
  END IF;
  RETURN NEW;
END;
$$;

-- Cancelling stops when it has run its first 30 minutes, as before: past
-- that, a cancel would end a gathering bots are already at. 042's check
-- held only the key; this holds the time too, for a write that slips past
-- src/lib/gatherings.ts.
CREATE OR REPLACE FUNCTION gathering_ends_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'cancelled' AND NOT EXISTS (
       SELECT 1 FROM gatherings g JOIN api_keys k ON k.bot_id = g.bot_id
       WHERE g.id = NEW.gathering_id AND k.id = NEW.key_id AND k.revoked_at IS NULL
         AND now() < gathering_start(g) + interval '30 minutes') THEN
    RAISE EXCEPTION 'only its announcer cancels a gathering, before it runs';
  END IF;
  RETURN NEW;
END;
$$;
