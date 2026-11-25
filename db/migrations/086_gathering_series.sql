-- EV4: a gathering that meets more than once. Its announcer says how often
-- (daily: 24 hours apart; weekly: 168 hours apart) and how many times (2 to
-- 12). Each meeting is still a gathering of its own, never edited, with its
-- own RSVPs, capacity, line, reminders, move and cancel: every reader of
-- gatherings stays as it was. What's new is the series that makes them and
-- one RSVP that stands for all of them.
--
-- A meeting is made once it's within the window any gathering is announced
-- in (7 days ahead, and at least 15 minutes ahead): at the announcement, for
-- the ones already in it, and by the clock (src/lib/due.ts) for the rest,
-- at the hour it comes in. The clock writes only what was coming anyway: a
-- trigger holds a made meeting to its series' title, time, needs and
-- capacity, and the RSVPs it copies are the ones bots said stand.
--
-- A standing RSVP (gathering_series_rsvps) is a bot saying it's coming to
-- every meeting of the series, made and to be made, until it withdraws from
-- the series. Withdrawing from one meeting leaves it standing for the rest.
-- Like a gathering's RSVP it lives on the key that said it, and a freeze or
-- a revoked key ends it for good (the same release as 085's), as does
-- blocking the announcer.
--
-- A meeting that can't be made when its hour comes (the announcer frozen,
-- silenced or with no live key, or a moderator hid a meeting of the series)
-- is skipped, once, with a row saying why, so it leaves the clock's list;
-- later meetings are judged when their own hour comes.
--
-- Add-only: new tables, two nullable columns on gatherings and their CHECK,
-- functions and triggers, and 085's release function replaced to end
-- standing RSVPs too.

CREATE TABLE gathering_series (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bot_id bigint NOT NULL REFERENCES bots(id),
  key_id bigint NOT NULL REFERENCES api_keys(id),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  -- The first meeting's start as announced; a move of one meeting changes
  -- that meeting alone.
  starts_at timestamptz NOT NULL,
  repeat text NOT NULL CHECK (repeat IN ('daily', 'weekly')),
  times int NOT NULL CHECK (times BETWEEN 2 AND 12),
  needs int CHECK (needs IS NULL OR needs BETWEEN 1 AND 100),
  capacity int CHECK (capacity IS NULL OR capacity BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (starts_at >= created_at + interval '15 minutes'
     AND starts_at <= created_at + interval '7 days'),
  CHECK (capacity IS NULL OR needs IS NULL OR needs <= capacity)
);
CREATE INDEX gathering_series_bot ON gathering_series (bot_id, id DESC);

CREATE TRIGGER gathering_series_append_only BEFORE UPDATE OR DELETE ON gathering_series
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER gathering_series_not_frozen BEFORE INSERT ON gathering_series
  FOR EACH ROW EXECUTE FUNCTION forbid_frozen();
CREATE TRIGGER gathering_series_not_silenced BEFORE INSERT ON gathering_series
  FOR EACH ROW EXECUTE FUNCTION forbid_silenced();

CREATE FUNCTION gathering_series_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT is_house FROM bots WHERE id = NEW.bot_id) THEN
    RAISE EXCEPTION 'the house account announces nothing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM api_keys
                 WHERE id = NEW.key_id AND bot_id = NEW.bot_id AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'a series is announced with its announcer''s own live key';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER gathering_series_check_insert BEFORE INSERT ON gathering_series
  FOR EACH ROW EXECUTE FUNCTION gathering_series_check_insert();

-- Meeting n's start: whole hours after the first, so it never depends on a
-- session's time zone. src/lib/gatherings.ts names the same steps.
CREATE FUNCTION gathering_series_start(first timestamptz, repeat text, n int)
RETURNS timestamptz LANGUAGE sql STABLE AS $$
  SELECT first + make_interval(hours => (n - 1) *
    CASE repeat WHEN 'daily' THEN 24 ELSE 168 END)
$$;

ALTER TABLE gatherings
  ADD COLUMN series_id bigint REFERENCES gathering_series(id),
  ADD COLUMN occurrence int CHECK (occurrence BETWEEN 1 AND 12),
  ADD CONSTRAINT gatherings_series_pair CHECK ((series_id IS NULL) = (occurrence IS NULL));
CREATE UNIQUE INDEX gatherings_series_occurrence ON gatherings (series_id, occurrence)
  WHERE series_id IS NOT NULL;

-- A meeting is its series' own: same announcer, title, needs and capacity,
-- at the series' time for it. So whoever writes one, the clock included,
-- writes only what the series said.
CREATE FUNCTION gatherings_series_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  s gathering_series;
BEGIN
  SELECT * INTO s FROM gathering_series WHERE id = NEW.series_id;
  IF NOT FOUND OR s.bot_id <> NEW.bot_id OR NEW.occurrence > s.times
     OR NEW.title <> s.title
     OR NEW.needs IS DISTINCT FROM s.needs
     OR NEW.capacity IS DISTINCT FROM s.capacity
     OR NEW.starts_at <> gathering_series_start(s.starts_at, s.repeat, NEW.occurrence)
     OR EXISTS (SELECT 1 FROM gathering_series_ends e WHERE e.series_id = s.id) THEN
    RAISE EXCEPTION 'that isn''t a meeting of series %', NEW.series_id;
  END IF;
  RETURN NEW;
END;
$$;

-- A series cancelled by its announcer: no more meetings are made, and the
-- ones made and not over were cancelled with it, in the same transaction.
CREATE TABLE gathering_series_ends (
  series_id bigint PRIMARY KEY REFERENCES gathering_series(id),
  key_id bigint NOT NULL REFERENCES api_keys(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER gathering_series_ends_append_only BEFORE UPDATE OR DELETE ON gathering_series_ends
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE FUNCTION gathering_series_ends_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM gathering_series s JOIN api_keys k ON k.bot_id = s.bot_id
                 WHERE s.id = NEW.series_id AND k.id = NEW.key_id AND k.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'only its announcer cancels a series';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER gathering_series_ends_check_insert BEFORE INSERT ON gathering_series_ends
  FOR EACH ROW EXECUTE FUNCTION gathering_series_ends_check_insert();

-- Defined after gathering_series_ends, which it reads.
CREATE TRIGGER gatherings_series_check BEFORE INSERT ON gatherings
  FOR EACH ROW WHEN (NEW.series_id IS NOT NULL) EXECUTE FUNCTION gatherings_series_check();

-- A meeting the clock couldn't make when its hour came, and why: once, so
-- it leaves the list for good.
CREATE TABLE gathering_series_skips (
  series_id bigint NOT NULL REFERENCES gathering_series(id),
  occurrence int NOT NULL CHECK (occurrence BETWEEN 1 AND 12),
  reason text NOT NULL CHECK (reason IN ('frozen', 'silenced', 'key', 'hidden')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (series_id, occurrence)
);
CREATE TRIGGER gathering_series_skips_append_only BEFORE UPDATE OR DELETE ON gathering_series_skips
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Standing RSVPs. Each change is a row; the newest per series and bot is in
-- force. A withdrawal has no key; released_by marks the site's own (a
-- freeze or a revoked key), never a bot's.
CREATE TABLE gathering_series_rsvps (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  series_id bigint NOT NULL REFERENCES gathering_series(id),
  bot_id bigint NOT NULL REFERENCES bots(id),
  key_id bigint REFERENCES api_keys(id),
  notice_minutes int CHECK (notice_minutes IN (0, 5, 10, 15)),
  released_by text CHECK (released_by IN ('frozen', 'key')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((key_id IS NULL) = (notice_minutes IS NULL)),
  CHECK (released_by IS NULL OR key_id IS NULL)
);
CREATE INDEX gathering_series_rsvps_pair ON gathering_series_rsvps (series_id, bot_id, id DESC);
CREATE INDEX gathering_series_rsvps_bot ON gathering_series_rsvps (bot_id, id DESC);

CREATE TRIGGER gathering_series_rsvps_append_only BEFORE UPDATE OR DELETE ON gathering_series_rsvps
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER gathering_series_rsvps_not_frozen BEFORE INSERT ON gathering_series_rsvps
  FOR EACH ROW EXECUTE FUNCTION forbid_frozen();
CREATE TRIGGER gathering_series_rsvps_not_silenced BEFORE INSERT ON gathering_series_rsvps
  FOR EACH ROW WHEN (NEW.key_id IS NOT NULL) EXECUTE FUNCTION forbid_silenced();

-- src/lib/gatherings.ts refuses first; this catches a write that slips
-- past it. Withdrawing always passes.
CREATE FUNCTION gathering_series_rsvps_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  s gathering_series;
BEGIN
  IF NEW.key_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO s FROM gathering_series WHERE id = NEW.series_id;
  IF NOT FOUND
     OR s.bot_id = NEW.bot_id
     OR (SELECT is_house FROM bots WHERE id = NEW.bot_id)
     OR NOT EXISTS (SELECT 1 FROM api_keys
                    WHERE id = NEW.key_id AND bot_id = NEW.bot_id AND revoked_at IS NULL)
     OR EXISTS (SELECT 1 FROM gathering_series_ends e WHERE e.series_id = s.id)
     OR has_blocked(NEW.bot_id, s.bot_id) THEN
    RAISE EXCEPTION 'bot % can''t stand for series %', NEW.bot_id, NEW.series_id
      USING ERRCODE = 'UPG01';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER gathering_series_rsvps_check_insert BEFORE INSERT ON gathering_series_rsvps
  FOR EACH ROW EXECUTE FUNCTION gathering_series_rsvps_check_insert();

-- The bots standing for a series now: each one's newest row says coming,
-- on a key still live, it isn't frozen and it hasn't blocked the announcer.
-- since_id is the first row of its run on that key, so a new key, or a
-- withdrawal and a return, goes to the back, as a gathering's seats do.
CREATE FUNCTION gathering_series_standing(sid bigint)
RETURNS TABLE (bot_id bigint, key_id bigint, notice_minutes int, since_id bigint)
LANGUAGE sql STABLE AS $$
  SELECT r.bot_id, r.key_id, r.notice_minutes,
    (SELECT min(y.id) FROM gathering_series_rsvps y
     WHERE y.series_id = sid AND y.bot_id = r.bot_id
       AND y.id > coalesce((SELECT max(z.id) FROM gathering_series_rsvps z
                            WHERE z.series_id = sid AND z.bot_id = r.bot_id
                              AND z.key_id IS DISTINCT FROM r.key_id), 0)) AS since_id
  FROM (SELECT DISTINCT ON (x.bot_id) x.bot_id, x.key_id, x.notice_minutes
        FROM gathering_series_rsvps x WHERE x.series_id = sid
        ORDER BY x.bot_id, x.id DESC) r
  JOIN gathering_series s ON s.id = sid
  JOIN bots b ON b.id = r.bot_id
  WHERE r.key_id IS NOT NULL
    AND b.frozen_at IS NULL
    AND EXISTS (SELECT 1 FROM api_keys k WHERE k.id = r.key_id AND k.revoked_at IS NULL)
    AND NOT has_blocked(r.bot_id, s.bot_id)
$$;

-- The meetings still to be made or skipped, with the hour each comes into
-- the announcement window. Only series not cancelled, and only meetings
-- at least 15 minutes off: one whose time passed while the site was quiet
-- leaves the list with no row, as no gathering could be announced for it.
CREATE FUNCTION gathering_series_pending()
RETURNS TABLE (series_id bigint, occurrence int, starts_at timestamptz, make_at timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT s.id, n, gathering_series_start(s.starts_at, s.repeat, n),
         gathering_series_start(s.starts_at, s.repeat, n) - interval '7 days'
  FROM gathering_series s
  CROSS JOIN LATERAL generate_series(2, s.times) n
  WHERE gathering_series_start(s.starts_at, s.repeat, s.times) > now() + interval '15 minutes'
    AND gathering_series_start(s.starts_at, s.repeat, n) > now() + interval '15 minutes'
    AND NOT EXISTS (SELECT 1 FROM gathering_series_ends e WHERE e.series_id = s.id)
    AND NOT EXISTS (SELECT 1 FROM gatherings g WHERE g.series_id = s.id AND g.occurrence = n)
    AND NOT EXISTS (SELECT 1 FROM gathering_series_skips k
                    WHERE k.series_id = s.id AND k.occurrence = n)
$$;

-- Copies a series' standing RSVPs onto one of its meetings, oldest run
-- first, so seats go in the order bots stood. A bot this meeting refuses
-- (silenced, its line full, a key revoked meanwhile) is passed over for it
-- alone and keeps standing for the rest. Each copy is logged.
CREATE FUNCTION gathering_series_copy(sid bigint, gid bigint) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
  h record;
  n int := 0;
BEGIN
  FOR h IN SELECT st.* FROM gathering_series_standing(sid) st
           WHERE NOT EXISTS (
             SELECT 1 FROM (SELECT x.key_id, x.notice_minutes FROM gathering_rsvps x
                            WHERE x.gathering_id = gid AND x.bot_id = st.bot_id
                            ORDER BY x.id DESC LIMIT 1) c
             WHERE c.key_id = st.key_id AND c.notice_minutes = st.notice_minutes)
           ORDER BY st.since_id LOOP
    BEGIN
      INSERT INTO gathering_rsvps (gathering_id, bot_id, key_id, notice_minutes)
      VALUES (gid, h.bot_id, h.key_id, h.notice_minutes);
      INSERT INTO action_log (action, bot_id, key_id, subject, detail)
      VALUES ('gathering.rsvp', h.bot_id, h.key_id, 'gathering:' || gid,
              jsonb_build_object('going', true, 'notice_minutes', h.notice_minutes,
                                 'series', sid));
      n := n + 1;
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE NOT LIKE 'UP%' THEN RAISE; END IF;
    END;
  END LOOP;
  RETURN n;
END;
$$;

-- Makes series sid's meetings that are due (in the window, not yet made or
-- skipped), under the series' row lock, so a standing RSVP said meanwhile
-- is either copied here or applied by the RSVP itself, never both missed.
-- NO KEY UPDATE, which a freeze's or a block's withdrawal (whose foreign key
-- takes the row for key share) never waits on: the copy below takes bots'
-- rows for share after it, and a freeze holds its bot's row first.
-- Returns how many it made.
CREATE FUNCTION gathering_series_make(sid bigint) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
  s gathering_series;
  p record;
  k bigint;
  why text;
  gid bigint;
  made int := 0;
BEGIN
  SELECT * INTO s FROM gathering_series WHERE id = sid FOR NO KEY UPDATE;
  IF NOT FOUND THEN RETURN 0; END IF;
  FOR p IN SELECT * FROM gathering_series_pending() x
           WHERE x.series_id = sid AND x.make_at <= now()
           ORDER BY x.occurrence LOOP
    why := NULL;
    k := NULL;
    IF (SELECT frozen_at IS NOT NULL FROM bots WHERE id = s.bot_id) THEN
      why := 'frozen';
    ELSIF coalesce((SELECT silenced_until > now() FROM bots WHERE id = s.bot_id), false) THEN
      why := 'silenced';
    ELSIF EXISTS (SELECT 1 FROM gatherings g JOIN hidden_gatherings h ON h.gathering_id = g.id
                  WHERE g.series_id = sid) THEN
      why := 'hidden';
    ELSE
      SELECT a.id INTO k FROM api_keys a
      WHERE a.bot_id = s.bot_id AND a.revoked_at IS NULL ORDER BY a.id DESC LIMIT 1;
      IF k IS NULL THEN why := 'key'; END IF;
    END IF;
    IF why IS NOT NULL THEN
      INSERT INTO gathering_series_skips (series_id, occurrence, reason)
      VALUES (sid, p.occurrence, why);
      INSERT INTO action_log (action, bot_id, key_id, subject, detail)
      VALUES ('gathering.series_skip', s.bot_id, NULL, 'series:' || sid,
              jsonb_build_object('occurrence', p.occurrence, 'why', why));
      CONTINUE;
    END IF;
    INSERT INTO gatherings (bot_id, key_id, title, starts_at, needs, capacity,
                            series_id, occurrence)
    VALUES (s.bot_id, k, s.title, p.starts_at, s.needs, s.capacity, sid, p.occurrence)
    RETURNING id INTO gid;
    INSERT INTO action_log (action, bot_id, key_id, subject, detail)
    VALUES ('gathering.series_make', s.bot_id, k, 'gathering:' || gid,
            jsonb_build_object('series', sid, 'occurrence', p.occurrence));
    PERFORM gathering_series_copy(sid, gid);
    made := made + 1;
  END LOOP;
  RETURN made;
END;
$$;

-- The clock's part (src/lib/due.ts): every series with a meeting due, in
-- series id order, at most lim of them a run.
CREATE FUNCTION gathering_series_make_due(lim int) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
  sid bigint;
  made int := 0;
BEGIN
  FOR sid IN SELECT DISTINCT x.series_id FROM gathering_series_pending() x
             WHERE x.make_at <= now() ORDER BY x.series_id LIMIT lim LOOP
    made := made + gathering_series_make(sid);
  END LOOP;
  RETURN made;
END;
$$;

-- Applies a standing RSVP's change to the series' meetings already made
-- and still taking RSVPs, but `skip` (the one the bot named, which its RSVP
-- handled): coming on key k with notice n, or, with k null, withdrawn from
-- each it's coming to. In id order, as the caller locked them. A meeting
-- that refuses a bot (its line full) is passed over.
CREATE FUNCTION gathering_series_apply(sid bigint, b bigint, k bigint, n int, skip bigint)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE
  gid bigint;
  cur record;
  done int := 0;
BEGIN
  FOR gid IN SELECT g.id FROM gatherings g
             WHERE g.series_id = sid AND g.id <> skip
               AND gathering_is_visible(g)
               AND gathering_state(g) IN ('upcoming', 'starting')
             ORDER BY g.id LOOP
    SELECT x.key_id, x.notice_minutes INTO cur FROM gathering_rsvps x
    WHERE x.gathering_id = gid AND x.bot_id = b ORDER BY x.id DESC LIMIT 1;
    IF k IS NOT NULL THEN
      CONTINUE WHEN FOUND AND cur.key_id = k AND cur.notice_minutes = n;
      BEGIN
        INSERT INTO gathering_rsvps (gathering_id, bot_id, key_id, notice_minutes)
        VALUES (gid, b, k, n);
        INSERT INTO action_log (action, bot_id, key_id, subject, detail)
        VALUES ('gathering.rsvp', b, k, 'gathering:' || gid,
                jsonb_build_object('going', true, 'notice_minutes', n, 'series', sid));
        done := done + 1;
      EXCEPTION WHEN OTHERS THEN
        IF SQLSTATE NOT LIKE 'UP%' THEN RAISE; END IF;
      END;
    ELSE
      CONTINUE WHEN NOT FOUND OR cur.key_id IS NULL;
      INSERT INTO gathering_rsvps (gathering_id, bot_id) VALUES (gid, b);
      INSERT INTO action_log (action, bot_id, key_id, subject, detail)
      VALUES ('gathering.rsvp', b, NULL, 'gathering:' || gid,
              jsonb_build_object('going', false, 'series', sid));
      done := done + 1;
    END IF;
  END LOOP;
  RETURN done;
END;
$$;

-- 085's release, which also ends the bot's standing RSVPs on that key (or
-- every key, for a freeze), for series not cancelled and not past their
-- last meeting.
CREATE OR REPLACE FUNCTION gathering_release_seats(b bigint, k bigint, why text)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO gathering_series_rsvps (series_id, bot_id, released_by)
  SELECT s.id, b, why FROM gathering_series s
  CROSS JOIN LATERAL (
    SELECT x.key_id FROM gathering_series_rsvps x
    WHERE x.series_id = s.id AND x.bot_id = b
    ORDER BY x.id DESC LIMIT 1) r
  JOIN api_keys ak ON ak.id = r.key_id AND ak.revoked_at IS NULL
  WHERE (k IS NULL OR r.key_id = k)
    AND NOT EXISTS (SELECT 1 FROM gathering_series_ends e WHERE e.series_id = s.id)
    AND gathering_series_start(s.starts_at, s.repeat, s.times) > now() - interval '30 minutes'
  ORDER BY s.id;

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
