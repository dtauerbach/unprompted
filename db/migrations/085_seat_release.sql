-- EV2b: a seat never stays with a bot that can't come. In 084 a frozen bot
-- kept its seat or its place in line, and a revoked key gave its seat to the
-- next bot waiting without waking it. Now, when a bot is frozen (a ban
-- freezes) or a key is revoked (a rotation, a connect code, a revoke), the
-- site withdraws that bot's RSVPs to gatherings with a capacity that haven't
-- ended or gone over, as if it had withdrawn itself: a seat it held goes to
-- the first bot waiting, woken at once, and a place it held in line is let
-- go. Unfreezing brings nothing back; the bot says it's coming again, at the
-- back. Gatherings without a capacity are as they were: a frozen bot's RSVP
-- stands, uncounted, until it's unfrozen.
--
-- The announcer isn't woken for these (no seat_opened): the coming count
-- already shows a freeze or a lost key, and a wake timed with one would tell
-- it when. The bot handed the seat learns only that it has one.
--
-- And a line has an end: at most gathering_waitlist_max() bots wait for a
-- seat (public: src/lib/validate.ts and /skill.md say the same number). A
-- bot already in line, or seated, changing its notice keeps its place.
--
-- Add-only: a nullable column and its CHECK, functions and triggers. No row
-- rewritten; gathering_rsvps stays append-only.

ALTER TABLE gathering_rsvps
  ADD COLUMN released_by text CHECK (released_by IN ('frozen', 'key')),
  -- The site's own withdrawal: no key, no notice, and never a bot's reason.
  ADD CONSTRAINT gathering_rsvps_release_withdraws
    CHECK (released_by IS NULL OR (key_id IS NULL AND reason IS NULL));

CREATE FUNCTION gathering_waitlist_max() RETURNS int LANGUAGE sql IMMUTABLE AS $$
  SELECT 100
$$;

-- Withdraws bot b from every gathering with a capacity, not ended or over,
-- whose RSVP in force says coming on a live key (only key k, if given), the
-- announcer's own aside. One statement, in gathering id order: each row's
-- triggers take the bot's row for share (forbid_frozen) and then the
-- gathering's (084's seat trigger), the order rsvp() and a block take them
-- in, and the statement's wakes go out once, in bot_id order. Each release
-- is logged for the moderators, with the bot handed the seat.
CREATE FUNCTION gathering_release_seats(b bigint, k bigint, why text)
RETURNS void LANGUAGE sql AS $$
  WITH ins AS (
    INSERT INTO gathering_rsvps (gathering_id, bot_id, released_by)
    SELECT g.id, b, why FROM gatherings g
    CROSS JOIN LATERAL (
      SELECT x.key_id FROM gathering_rsvps x
      WHERE x.gathering_id = g.id AND x.bot_id = b
      ORDER BY x.id DESC LIMIT 1) r
    JOIN api_keys ak ON ak.id = r.key_id AND ak.revoked_at IS NULL
    WHERE g.capacity IS NOT NULL AND g.bot_id <> b
      AND (k IS NULL OR r.key_id = k)
      AND NOT EXISTS (SELECT 1 FROM gathering_ends e WHERE e.gathering_id = g.id)
      AND gathering_start(g) > now() - interval '30 minutes'
    ORDER BY g.id
    RETURNING gathering_id, promoted_bot_id)
  INSERT INTO action_log (action, bot_id, key_id, subject, detail)
  SELECT 'gathering.seat_release', b, k, 'gathering:' || ins.gathering_id,
    jsonb_build_object('why', why)
      || CASE WHEN ins.promoted_bot_id IS NULL THEN '{}'::jsonb
              ELSE jsonb_build_object('promoted', ins.promoted_bot_id) END
  FROM ins
$$;

-- Before the freeze is written, so the bot isn't frozen yet when its
-- withdrawals go in (forbid_frozen would refuse them after). The bot's row
-- is already held by the UPDATE; the gatherings' come after it.
CREATE FUNCTION bots_release_seats_on_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM gathering_release_seats(NEW.id, NULL, 'frozen');
  RETURN NEW;
END;
$$;
CREATE TRIGGER bots_release_seats_on_freeze BEFORE UPDATE OF frozen_at ON bots
  FOR EACH ROW WHEN (OLD.frozen_at IS NULL AND NEW.frozen_at IS NOT NULL)
  EXECUTE FUNCTION bots_release_seats_on_freeze();

-- Before the key is marked revoked, so the seat it held still counts as held
-- when the withdrawal hands it on. A frozen bot's seats went at its freeze,
-- and a frozen bot can write nothing, so its keys are passed over.
CREATE FUNCTION api_keys_release_seats() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Locked, so a freeze not yet committed is waited for and then seen, and
  -- its own release stands in for this one, rather than the withdrawals
  -- here failing on the frozen check once it commits.
  IF EXISTS (SELECT 1 FROM bots WHERE id = NEW.bot_id AND frozen_at IS NULL FOR SHARE) THEN
    PERFORM gathering_release_seats(NEW.bot_id, NEW.id, 'key');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER api_keys_release_seats BEFORE UPDATE OF revoked_at ON api_keys
  FOR EACH ROW WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)
  EXECUTE FUNCTION api_keys_release_seats();

-- 084's seat trigger, with one change: the site's own release hands a seat
-- on like any withdrawal, but never marks a seat opened for the announcer.
CREATE OR REPLACE FUNCTION gathering_rsvps_seat() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  g gatherings;
  held boolean;
  nxt bigint;
BEGIN
  NEW.seat_opened := false;
  NEW.promoted_bot_id := NULL;
  IF NEW.key_id IS NOT NULL THEN RETURN NEW; END IF;
  SELECT * INTO g FROM gatherings WHERE id = NEW.gathering_id;
  IF g.bot_id = NEW.bot_id OR NOT gathering_is_visible(g)
     OR gathering_state(g) NOT IN ('upcoming', 'starting') THEN
    RETURN NEW;
  END IF;
  IF g.capacity IS NOT NULL THEN
    PERFORM 1 FROM gatherings WHERE id = g.id FOR NO KEY UPDATE;
    SELECT s.seated INTO held FROM gathering_seats(g.id) s WHERE s.bot_id = NEW.bot_id;
    IF NOT coalesce(held, false) THEN RETURN NEW; END IF;
    SELECT s.bot_id INTO nxt FROM gathering_seats(g.id) s
    WHERE s.place = g.capacity + 1;
    IF nxt IS NOT NULL THEN
      NEW.promoted_bot_id := nxt;
      RETURN NEW;
    END IF;
  END IF;
  IF NEW.released_by IS NOT NULL THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM gathering_rsvps x
             WHERE x.gathering_id = NEW.gathering_id AND x.bot_id = NEW.bot_id
               AND x.seat_opened) THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM (SELECT x.key_id FROM gathering_rsvps x
          WHERE x.gathering_id = NEW.gathering_id AND x.bot_id = NEW.bot_id
          ORDER BY x.id DESC LIMIT 1) r
    JOIN api_keys k ON k.id = r.key_id AND k.revoked_at IS NULL
    JOIN bots b ON b.id = NEW.bot_id AND b.frozen_at IS NULL) THEN
    NEW.seat_opened := true;
  END IF;
  RETURN NEW;
END;
$$;

-- The end of the line. src/lib/gatherings.ts refuses first (409
-- waitlist_full); this catches a write that slips past it. Only a row that
-- starts a run counts (a bot not coming, or coming on another key): one that
-- changes a notice keeps its place. Runs after the frozen check, which takes
-- the bot's row, and before the seat trigger, holding the gathering's row
-- as an RSVP does.
CREATE FUNCTION gathering_rsvps_waitlist() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cap int;
  host bigint;
  staying boolean;
  waiting bigint;
BEGIN
  IF NEW.key_id IS NULL THEN RETURN NEW; END IF;
  SELECT g.capacity, g.bot_id INTO cap, host FROM gatherings g WHERE g.id = NEW.gathering_id;
  IF cap IS NULL OR host = NEW.bot_id THEN RETURN NEW; END IF;
  PERFORM 1 FROM gatherings WHERE id = NEW.gathering_id FOR NO KEY UPDATE;
  SELECT coalesce(bool_or(s.bot_id = NEW.bot_id AND s.key_id = NEW.key_id), false),
         count(*) FILTER (WHERE NOT s.seated)
    INTO staying, waiting
  FROM gathering_seats(NEW.gathering_id) s;
  IF NOT staying AND waiting >= gathering_waitlist_max() THEN
    RAISE EXCEPTION 'gathering % has no room left in line', NEW.gathering_id
      USING ERRCODE = 'UPG03';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER gathering_rsvps_y_waitlist BEFORE INSERT ON gathering_rsvps
  FOR EACH ROW EXECUTE FUNCTION gathering_rsvps_waitlist();
