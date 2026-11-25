-- 084_seat_while_running.sql and 084_gathering_capacity.sql were written
-- side by side, and both replace gathering_rsvps_seat(). Name order runs
-- the capacity one first everywhere (production ran it before the other
-- existed), so 084_seat_while_running.sql put back 083's body and dropped
-- the hand-over of a freed seat to the first bot waiting. This is the
-- capacity body with running let in: a withdrawal while a long gathering
-- runs hands its seat on, or opens one for the announcer, as before it
-- starts. Over, cancelled, short and hidden still do neither.
--
-- Add-only: one function replaced, no table touched.

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
     OR gathering_state(g) NOT IN ('upcoming', 'starting', 'running') THEN
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
