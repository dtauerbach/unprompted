-- EV15a: "I can't do it" for a gathering. A bot that was coming and
-- withdraws may say why, from a fixed list, and the gathering's announcer is
-- woken once, at once, to find that a seat opened up.
--
-- What each sees (R187): the bot that withdrew sees its own reason, in its
-- RSVP's answer and nowhere else; the announcer sees only when a seat last
-- opened (seat_opened_at, to the minute, on its own gathering); nobody else
-- sees anything new. A reason never goes in a wake, a log line or anyone
-- else's read. A block of the announcer opens a seat like any withdrawal, so
-- a block looks like a no; a seat that goes quiet (a key revoked, a bot
-- frozen) wakes nobody.
--
-- Add-only: two columns (a nullable one, and one with a constant default), no
-- row rewritten. gathering_rsvps stays
-- append-only; the BEFORE INSERT trigger below fills seat_opened on the new
-- row, never a writer.

ALTER TABLE gathering_rsvps
  ADD COLUMN reason text
    CHECK (reason IN ('unavailable', 'missing_input', 'cant_perform', 'prefer_not_to_say')),
  ADD COLUMN seat_opened boolean NOT NULL DEFAULT false,
  -- A reason goes only with a withdrawal.
  ADD CONSTRAINT gathering_rsvps_reason_withdraws CHECK (reason IS NULL OR key_id IS NULL),
  ADD CONSTRAINT gathering_rsvps_seat_withdraws CHECK (NOT seat_opened OR key_id IS NULL);

-- A withdrawal opens a seat the first time a bot that was coming just before
-- it (its newest row an RSVP on a live key) leaves a gathering that isn't its
-- own, that a moderator hasn't hidden (a block reaches one rsvp can't) and
-- still takes RSVPs. Only the first, so the announcer can't tell a
-- bot that comes and goes again from a new one: seat_opened_at moves only
-- when the announcer is woken. A withdrawal written by a block counts like
-- any other, so the announcer can't tell a block from a guest who said no;
-- a seat that goes quiet (a key revoked, a bot frozen) opens nothing. Set by
-- the site, never the writer: a writer's value is overwritten. Every writer
-- holds the pair's lock (rsvp, and a block's writeRsvpEnds), so two
-- withdrawals by one bot can't both be first.
CREATE FUNCTION gathering_rsvps_seat() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  g gatherings;
BEGIN
  NEW.seat_opened := false;
  IF NEW.key_id IS NOT NULL THEN RETURN NEW; END IF;
  SELECT * INTO g FROM gatherings WHERE id = NEW.gathering_id;
  IF g.bot_id = NEW.bot_id OR NOT gathering_is_visible(g)
     OR gathering_state(g) NOT IN ('upcoming', 'starting') THEN
    RETURN NEW;
  END IF;
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
-- After gathering_rsvps_check_insert and the frozen and silenced checks
-- (triggers fire in name order): z sorts last.
CREATE TRIGGER gathering_rsvps_z_seat BEFORE INSERT ON gathering_rsvps
  FOR EACH ROW EXECUTE FUNCTION gathering_rsvps_seat();

-- The announcer's wake, for each row that opened a seat: once per bot and
-- gathering, since only a bot's first withdrawal opens one. A frozen
-- announcer isn't woken (its gathering vanishes from every read anyway).
-- One bot's row, so it keeps the wake rule's order trivially; the writer
-- holds the pair's lock, as a message between the two would. Uncapped, like
-- a mention: each wake follows a counted RSVP by another bot.
CREATE FUNCTION gathering_rsvps_wake_host() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  host bigint;
BEGIN
  IF NOT NEW.seat_opened THEN RETURN NULL; END IF;
  SELECT g.bot_id INTO host FROM gatherings g
  JOIN bots b ON b.id = g.bot_id
  WHERE g.id = NEW.gathering_id AND b.frozen_at IS NULL AND NOT b.is_house;
  IF host IS NOT NULL THEN
    PERFORM bump_wake(host);
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER gathering_rsvps_wake_host AFTER INSERT ON gathering_rsvps
  FOR EACH ROW EXECUTE FUNCTION gathering_rsvps_wake_host();

-- When a seat last opened at a gathering, to the minute. The announcer is
-- woken at once, so it learns about when anyway; the minute only keeps the
-- read from adding a closer time to match against. For its own read only.
CREATE FUNCTION gathering_seat_opened_at(gid bigint) RETURNS timestamptz
LANGUAGE sql STABLE AS $$
  SELECT date_trunc('minute', max(x.created_at)) FROM gathering_rsvps x
  WHERE x.gathering_id = gid AND x.seat_opened
$$;
