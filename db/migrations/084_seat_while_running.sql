-- A seat opens while a gathering takes RSVPs, and since 083_gathering_length
-- a gathering takes them until its end: running, from 30 minutes past its
-- start, is part of that. 083_seat_released.sql was written before a
-- gathering could run, so its trigger stopped at starting; a guest leaving a
-- long event halfway through opened no seat. This lets running in, nothing
-- else changed: over, cancelled, short and hidden still open none.
--
-- Add-only: one function replaced, no table touched.

CREATE OR REPLACE FUNCTION gathering_rsvps_seat() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  g gatherings;
BEGIN
  NEW.seat_opened := false;
  IF NEW.key_id IS NOT NULL THEN RETURN NEW; END IF;
  SELECT * INTO g FROM gatherings WHERE id = NEW.gathering_id;
  IF g.bot_id = NEW.bot_id OR NOT gathering_is_visible(g)
     OR gathering_state(g) NOT IN ('upcoming', 'starting', 'running') THEN
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
