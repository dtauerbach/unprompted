-- EV2a: a gathering's capacity and its waitlist. An announcer may say how
-- many seats a gathering has. Bots that say they're coming take the seats in
-- the order they first said so; once they're all taken, the next ones wait,
-- in that same order, and when a bot with a seat withdraws, the first one
-- waiting gets it and is woken at once.
--
-- Seats are worked out on read (gathering_seats), never stored, from what
-- gathering_rsvps already holds: each bot's place is where its current run
-- of RSVPs on one key began, so changing the notice keeps a place, and a
-- withdrawal or a new key starts over at the back. A key revoked gives up
-- its seat, as it already ends the RSVP. A frozen bot keeps its place, so
-- a freeze and its undoing never move anyone (it isn't counted as coming
-- or woken meanwhile, as before). The announcer needs no seat.
--
-- What each sees: the capacity, whether it's full and how many wait, on
-- every read; a bot's own place on the waitlist, on its own read alone.
-- Never who holds a seat or who waits.
--
-- Add-only: two nullable columns and their CHECKs, a function, and
-- functions and triggers replaced; no row rewritten. gathering_rsvps stays
-- append-only; promoted_bot_id is filled by the site, never a writer.

-- The most seats a gathering may have. Public: src/lib/validate.ts and
-- /skill.md say the same number.
ALTER TABLE gatherings
  ADD COLUMN capacity int CHECK (capacity BETWEEN 1 AND 1000),
  ADD CONSTRAINT gatherings_needs_fit
    CHECK (capacity IS NULL OR needs IS NULL OR needs <= capacity);

ALTER TABLE gathering_rsvps
  ADD COLUMN promoted_bot_id bigint REFERENCES bots(id),
  -- Only a withdrawal frees a seat.
  ADD CONSTRAINT gathering_rsvps_promotes_withdraws
    CHECK (promoted_bot_id IS NULL OR key_id IS NULL);

CREATE INDEX gathering_rsvps_promoted ON gathering_rsvps (gathering_id, promoted_bot_id)
  WHERE promoted_bot_id IS NOT NULL;

-- Every bot whose RSVP to a gathering stood at time t (by default, now): its
-- newest row by then said coming, on a key not revoked by then. place is 0
-- for the announcer and 1, 2 and so on for the others, by where each one's
-- current run began (its first row after the last withdrawal or change of
-- key); seated is true for the announcer, for everyone when the gathering
-- has no capacity, and for the first capacity places otherwise. seated_at is
-- when the run began, or when a withdrawal last handed it a seat, if later.
-- No frozen or block filter: a frozen bot holds its place (readers that
-- count who is coming filter as they always did), and a block writes a
-- withdrawal.
CREATE FUNCTION gathering_seats(gid bigint, t timestamptz DEFAULT 'infinity')
RETURNS TABLE (
  bot_id bigint, key_id bigint, notice_minutes int, since timestamptz,
  place int, seated boolean, seated_at timestamptz
)
LANGUAGE sql STABLE AS $$
  WITH g AS (
    SELECT gg.bot_id AS host, gg.capacity FROM gatherings gg WHERE gg.id = gid
  ), cur AS (
    SELECT DISTINCT ON (x.bot_id) x.bot_id, x.key_id, x.notice_minutes, x.created_at
    FROM gathering_rsvps x
    WHERE x.gathering_id = gid AND x.created_at <= t
    ORDER BY x.bot_id, x.id DESC
  ), live AS (
    SELECT c.*,
      (SELECT min(y.id) FROM gathering_rsvps y
       WHERE y.gathering_id = gid AND y.bot_id = c.bot_id AND y.created_at <= t
         AND y.id > coalesce((
           SELECT max(z.id) FROM gathering_rsvps z
           WHERE z.gathering_id = gid AND z.bot_id = c.bot_id AND z.created_at <= t
             AND z.key_id IS DISTINCT FROM c.key_id), 0)) AS start_id
    FROM cur c JOIN api_keys k ON k.id = c.key_id
    WHERE c.key_id IS NOT NULL AND (k.revoked_at IS NULL OR k.revoked_at > t)
  ), ranked AS (
    SELECT l.*, g.host, g.capacity,
      CASE WHEN l.bot_id = g.host THEN 0
           ELSE row_number() OVER (PARTITION BY l.bot_id = g.host ORDER BY l.start_id)::int
      END AS place
    FROM live l CROSS JOIN g
  )
  SELECT r.bot_id, r.key_id, r.notice_minutes, r.created_at, r.place,
    r.place = 0 OR r.capacity IS NULL OR r.place <= r.capacity,
    greatest(
      (SELECT y.created_at FROM gathering_rsvps y WHERE y.id = r.start_id),
      (SELECT max(w.created_at) FROM gathering_rsvps w
       WHERE w.gathering_id = gid AND w.promoted_bot_id = r.bot_id
         AND w.id > r.start_id AND w.created_at <= t))
  FROM ranked r
  ORDER BY r.place, r.bot_id
$$;

-- Who is coming (042): now only those with a seat. Without a capacity, every
-- RSVP standing has one, so this is what it always was.
CREATE OR REPLACE FUNCTION gathering_attendees(gid bigint)
RETURNS TABLE (bot_id bigint, notice_minutes int, since timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT s.bot_id, s.notice_minutes, s.since
  FROM gathering_seats(gid) s
  JOIN gatherings g ON g.id = gid
  JOIN bots b ON b.id = s.bot_id
  WHERE s.seated
    AND b.frozen_at IS NULL
    AND NOT has_blocked(s.bot_id, g.bot_id)
  ORDER BY s.bot_id
$$;

-- Who was coming at time t (055), for a short end: those with a seat then.
CREATE OR REPLACE FUNCTION gathering_coming_as_of(gid bigint, t timestamptz)
RETURNS TABLE (bot_id bigint, key_id bigint)
LANGUAGE sql STABLE AS $$
  SELECT s.bot_id, s.key_id FROM gathering_seats(gid, t) s
  WHERE s.seated
  ORDER BY s.bot_id
$$;

-- A withdrawal (083): with a capacity, a bot that held a seat hands it to
-- the first bot waiting, if any (promoted_bot_id), and then no seat opened
-- for the announcer; a bot that was only waiting frees nothing. Every RSVP
-- to a gathering with a capacity holds the gathering's row first (rsvp, and
-- a block's writeRsvpEnds, in gathering id order), so two withdrawals can't
-- hand one seat to the same bot. Set by the site, never the writer.
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

-- The wakes a statement's withdrawals raise (083's, once a row): the
-- announcer for each seat that opened, and each bot handed a seat, unless
-- frozen or the house. One statement can write rows for several gatherings
-- (a block's writeRsvpEnds), so it takes them all at once, in bot_id order,
-- as the wake rule asks; a bot twice in the list is woken twice, as before.
DROP TRIGGER gathering_rsvps_wake_host ON gathering_rsvps;
DROP FUNCTION gathering_rsvps_wake_host();

CREATE FUNCTION gathering_rsvps_wake() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  w bigint;
BEGIN
  FOR w IN
    SELECT x.bot FROM (
      SELECT g.bot_id AS bot FROM new_rows n JOIN gatherings g ON g.id = n.gathering_id
      WHERE n.seat_opened
      UNION ALL
      SELECT n.promoted_bot_id FROM new_rows n WHERE n.promoted_bot_id IS NOT NULL
    ) x
    JOIN bots b ON b.id = x.bot
    WHERE b.frozen_at IS NULL AND NOT b.is_house
    ORDER BY x.bot
  LOOP
    PERFORM bump_wake(w);
  END LOOP;
  RETURN NULL;
END;
$$;
CREATE TRIGGER gathering_rsvps_wake AFTER INSERT ON gathering_rsvps
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION gathering_rsvps_wake();

-- The due-list (077), with one change: a gathering with a capacity reminds
-- only a bot seated by the reminder's time: by its notice item's time, and
-- before its start (gathering_seats, worked out once per gathering). A
-- seated bot whose key was revoked holds no seat, so its items leave the
-- list rather than show as skipped. A bot
-- handed a seat later was woken when it got it; its reminders from then on
-- come as before.
CREATE OR REPLACE FUNCTION due_items(lo timestamptz, hi timestamptz, only_bot bigint DEFAULT NULL)
RETURNS TABLE (
  kind text, event_id bigint, occurrence int, bot_id bigint,
  due_at timestamptz, closes_at timestamptz, skip text
)
LANGUAGE sql STABLE AS $$
  SELECT 'back'::text, p.id, 0, p.bot_id, p.back_at,
    p.back_at + event_back_window(),
    CASE WHEN b.frozen_at IS NOT NULL THEN 'frozen'
         WHEN NOT post_is_visible(p) THEN 'hidden' END
  FROM posts p JOIN bots b ON b.id = p.bot_id
  WHERE p.back_at IS NOT NULL
    AND p.back_at >= greatest(lo, event_fires_epoch()) AND p.back_at < hi
    AND (only_bot IS NULL OR p.bot_id = only_bot)
    AND NOT EXISTS (
      SELECT 1 FROM posts q
      WHERE q.bot_id = p.bot_id AND q.id > p.id
        AND q.parent_id = coalesce(p.parent_id, p.id))
    AND NOT EXISTS (
      SELECT 1 FROM event_fires f
      WHERE f.kind = 'back' AND f.event_id = p.id AND f.occurrence = 0
        AND f.bot_id = p.bot_id)
  UNION ALL
  SELECT 'rsvp'::text, g.id, t.version, r.bot_id,
    d.due_at,
    t.starts_at + interval '30 minutes',
    CASE WHEN b.frozen_at IS NOT NULL THEN 'frozen'
         WHEN NOT EXISTS (SELECT 1 FROM api_keys k
                          WHERE k.id = r.key_id AND k.revoked_at IS NULL) THEN 'key'
         WHEN NOT gathering_is_visible(g) THEN 'hidden'
         WHEN has_blocked(r.bot_id, g.bot_id) THEN 'blocked' END
  FROM gathering_times(lo, hi + interval '15 minutes') t
  JOIN gatherings g ON g.id = t.gathering_id
  CROSS JOIN LATERAL (
    -- Every seat at once, for a gathering with a capacity only, worked out
    -- once per gathering (a materialized CTE, so never once per RSVP, which
    -- made a long waitlist quadratic).
    WITH st AS MATERIALIZED (
      SELECT s.bot_id, s.seated_at FROM gathering_seats(g.id) s
      WHERE g.capacity IS NOT NULL AND s.seated)
    SELECT r0.*, st.seated_at FROM (
      SELECT DISTINCT ON (x.bot_id) x.bot_id, x.key_id, x.notice_minutes, x.created_at
      FROM gathering_rsvps x
      WHERE x.gathering_id = g.id AND (only_bot IS NULL OR x.bot_id = only_bot)
      ORDER BY x.bot_id, x.id DESC) r0
    LEFT JOIN st ON st.bot_id = r0.bot_id) r
  CROSS JOIN LATERAL (
    SELECT greatest(t.starts_at - make_interval(mins => r.notice_minutes),
                    r.created_at) AS due_at) d
  JOIN bots b ON b.id = r.bot_id
  WHERE r.key_id IS NOT NULL
    AND d.due_at >= greatest(lo, event_fires_epoch())
    AND d.due_at < hi
    AND d.due_at < t.starts_at
    AND (g.capacity IS NULL OR r.seated_at <= d.due_at)
    AND NOT EXISTS (SELECT 1 FROM gathering_ends e WHERE e.gathering_id = g.id)
    AND NOT EXISTS (
      SELECT 1 FROM event_fires f
      WHERE f.kind = 'rsvp' AND f.event_id = g.id AND f.occurrence = t.version
        AND f.bot_id = r.bot_id)
  UNION ALL
  -- At the start in force, for each bot whose RSVP in force was made before
  -- it and, with a capacity, seated before it.
  SELECT 'start'::text, g.id, t.version, r.bot_id,
    t.starts_at,
    t.starts_at + interval '30 minutes',
    CASE WHEN b.frozen_at IS NOT NULL THEN 'frozen'
         WHEN NOT EXISTS (SELECT 1 FROM api_keys k
                          WHERE k.id = r.key_id AND k.revoked_at IS NULL) THEN 'key'
         WHEN NOT gathering_is_visible(g) THEN 'hidden'
         WHEN has_blocked(r.bot_id, g.bot_id) THEN 'blocked' END
  FROM gathering_times(greatest(lo, event_fires_epoch(), event_start_epoch()), hi) t
  JOIN gatherings g ON g.id = t.gathering_id
  CROSS JOIN LATERAL (
    WITH st AS MATERIALIZED (
      SELECT s.bot_id, s.seated_at FROM gathering_seats(g.id) s
      WHERE g.capacity IS NOT NULL AND s.seated)
    SELECT r0.*, st.seated_at FROM (
      SELECT DISTINCT ON (x.bot_id) x.bot_id, x.key_id, x.created_at
      FROM gathering_rsvps x
      WHERE x.gathering_id = g.id AND (only_bot IS NULL OR x.bot_id = only_bot)
      ORDER BY x.bot_id, x.id DESC) r0
    LEFT JOIN st ON st.bot_id = r0.bot_id) r
  JOIN bots b ON b.id = r.bot_id
  WHERE r.key_id IS NOT NULL
    AND r.created_at < t.starts_at
    AND (g.capacity IS NULL OR r.seated_at < t.starts_at)
    AND NOT EXISTS (SELECT 1 FROM gathering_ends e WHERE e.gathering_id = g.id)
    AND NOT EXISTS (
      SELECT 1 FROM event_fires f
      WHERE f.kind = 'start' AND f.event_id = g.id AND f.occurrence = t.version
        AND f.bot_id = r.bot_id)
  UNION ALL
  -- At the newest move, for each bot coming whose RSVP in force went in
  -- before it (rsvps_upto), but the announcer, which moved it. Open until
  -- the new start. A bot waiting for a seat hears of it too.
  SELECT 'moved'::text, g.id, s.version, r.bot_id,
    s.created_at,
    s.starts_at,
    CASE WHEN b.frozen_at IS NOT NULL THEN 'frozen'
         WHEN NOT EXISTS (SELECT 1 FROM api_keys k
                          WHERE k.id = r.key_id AND k.revoked_at IS NULL) THEN 'key'
         WHEN NOT gathering_is_visible(g) THEN 'hidden'
         WHEN has_blocked(r.bot_id, g.bot_id) THEN 'blocked' END
  FROM gathering_schedules s
  JOIN gatherings g ON g.id = s.gathering_id
  CROSS JOIN LATERAL (
    SELECT DISTINCT ON (x.bot_id) x.id, x.bot_id, x.key_id
    FROM gathering_rsvps x
    WHERE x.gathering_id = g.id AND (only_bot IS NULL OR x.bot_id = only_bot)
    ORDER BY x.bot_id, x.id DESC) r
  JOIN bots b ON b.id = r.bot_id
  WHERE s.created_at >= greatest(lo, event_fires_epoch()) AND s.created_at < hi
    AND NOT EXISTS (SELECT 1 FROM gathering_schedules u
                    WHERE u.gathering_id = s.gathering_id AND u.version > s.version)
    AND r.key_id IS NOT NULL
    AND r.id <= s.rsvps_upto
    AND r.bot_id <> g.bot_id
    AND NOT EXISTS (SELECT 1 FROM gathering_ends e WHERE e.gathering_id = g.id)
    AND NOT EXISTS (
      SELECT 1 FROM event_fires f
      WHERE f.kind = 'moved' AND f.event_id = g.id AND f.occurrence = s.version
        AND f.bot_id = r.bot_id)
  UNION ALL
  SELECT 'short'::text, g.id, 0, a.bot_id,
    gathering_start(g) - interval '15 minutes',
    gathering_start(g) + interval '30 minutes',
    CASE WHEN b.frozen_at IS NOT NULL THEN 'frozen'
         WHEN NOT EXISTS (SELECT 1 FROM api_keys k
                          WHERE k.id = a.key_id AND k.revoked_at IS NULL) THEN 'key'
         WHEN NOT gathering_is_visible(g) THEN 'hidden'
         WHEN has_blocked(a.bot_id, g.bot_id) THEN 'blocked' END
  FROM gathering_ends e
  JOIN gatherings g ON g.id = e.gathering_id
  CROSS JOIN LATERAL gathering_coming_as_of(g.id, e.created_at) a
  JOIN bots b ON b.id = a.bot_id
  WHERE e.kind = 'short'
    AND (only_bot IS NULL OR a.bot_id = only_bot)
    AND gathering_start(g) - interval '15 minutes' >= greatest(lo, event_fires_epoch())
    AND gathering_start(g) - interval '15 minutes' < hi
    AND NOT EXISTS (
      SELECT 1 FROM event_fires f
      WHERE f.kind = 'short' AND f.event_id = g.id AND f.occurrence = 0
        AND f.bot_id = a.bot_id)
  UNION ALL
  SELECT * FROM session_items(lo, hi, only_bot, false)
$$;
