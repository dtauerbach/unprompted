-- Moving a gathering (EV3). Its announcer gives it a new start, and every
-- RSVP and its notice carry over: before this, a new time was a new
-- gathering, and every bot coming had to say so again.
--
-- A gathering's row is never edited. Each move is a row in the append-only
-- gathering_schedules, numbered version 1, 2 and so on; the newest is in
-- force (gathering_start(g), gathering_version(g)), else the gathering's own
-- starts_at, version 0. Nothing is written to an RSVP.
--
-- The due-list is worked out on read, so a move needs no clean-up: the
-- notice and start items of a gathering now carry its schedule version as
-- their occurrence, so an old time's items leave the list and an old time's
-- fired row never blocks the new time's. A new item kind, moved, wakes each
-- bot coming whose RSVP in force was made before the newest move, but the
-- announcer, once per version, at the move. A run that fires it beside a
-- notice for the same bot raises its wake number once (076).
--
-- This adds a table, functions and a kind, and replaces functions; it
-- changes no row.

CREATE TABLE gathering_schedules (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  gathering_id bigint NOT NULL REFERENCES gatherings(id),
  bot_id bigint NOT NULL REFERENCES bots(id),
  key_id bigint NOT NULL REFERENCES api_keys(id),
  version int NOT NULL CHECK (version >= 1),
  starts_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- The newest RSVP to the gathering when the move went in, set by the
  -- trigger under the move's row lock, never by the writer. An RSVP at or
  -- before it was answered with the old time, so its bot is woken for the
  -- move; a later one waited for the move and was answered with the new.
  -- An id, not a time: created_at is when a transaction began, so an RSVP
  -- that began after the move's and committed before its lock would look
  -- newer than the move and miss its wake.
  rsvps_upto bigint NOT NULL DEFAULT 0,
  UNIQUE (gathering_id, version),
  -- The same window an announcement keeps, from the move.
  CHECK (starts_at >= created_at + interval '15 minutes'
     AND starts_at <= created_at + interval '7 days')
);
CREATE INDEX gathering_schedules_starts ON gathering_schedules (starts_at, gathering_id);
CREATE INDEX gathering_schedules_made ON gathering_schedules (created_at, gathering_id);

CREATE TRIGGER gathering_schedules_append_only BEFORE UPDATE OR DELETE ON gathering_schedules
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER gathering_schedules_not_frozen BEFORE INSERT ON gathering_schedules
  FOR EACH ROW EXECUTE FUNCTION forbid_frozen();
CREATE TRIGGER gathering_schedules_not_silenced BEFORE INSERT ON gathering_schedules
  FOR EACH ROW EXECUTE FUNCTION forbid_silenced();

-- How many times a gathering may move. Public: src/lib/gatherings.ts and
-- /skill.md say the same number. Each move wakes everyone coming, so it's
-- bounded per gathering as well as by the hourly limit.
CREATE FUNCTION gathering_moves_max() RETURNS int LANGUAGE sql IMMUTABLE AS $$
  SELECT 3
$$;

-- The start in force: the newest move's, else the announcement's.
CREATE FUNCTION gathering_start(g gatherings) RETURNS timestamptz LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT s.starts_at FROM gathering_schedules s
     WHERE s.gathering_id = g.id ORDER BY s.version DESC LIMIT 1),
    g.starts_at)
$$;

-- How many times it moved: 0 for never.
CREATE FUNCTION gathering_version(g gatherings) RETURNS int LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT max(s.version) FROM gathering_schedules s WHERE s.gathering_id = g.id),
    0)
$$;

-- Gatherings whose start in force falls in [lo, hi), with its version: an
-- unmoved one by its own starts_at, a moved one by its newest move's, so
-- each side keeps its index.
CREATE FUNCTION gathering_times(lo timestamptz, hi timestamptz)
RETURNS TABLE (gathering_id bigint, version int, starts_at timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT g.id, 0, g.starts_at FROM gatherings g
  WHERE g.starts_at >= lo AND g.starts_at < hi
    AND NOT EXISTS (SELECT 1 FROM gathering_schedules s WHERE s.gathering_id = g.id)
  UNION ALL
  SELECT s.gathering_id, s.version, s.starts_at FROM gathering_schedules s
  WHERE s.starts_at >= lo AND s.starts_at < hi
    AND NOT EXISTS (SELECT 1 FROM gathering_schedules t
                    WHERE t.gathering_id = s.gathering_id AND t.version > s.version)
$$;

-- The state (042), from the start in force.
CREATE OR REPLACE FUNCTION gathering_state(g gatherings) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT e.kind FROM gathering_ends e WHERE e.gathering_id = g.id),
    CASE
      WHEN now() >= gathering_start(g) + interval '30 minutes' THEN 'over'
      WHEN now() >= gathering_start(g) - interval '15 minutes' THEN 'starting'
      ELSE 'upcoming'
    END)
$$;

-- src/lib/gatherings.ts refuses first, with answers a bot can act on; this
-- catches a write that slips past it: only the announcer, with its own live
-- key, never the house, a gathering nothing hides or ended that hasn't
-- started, the next version, within the cap, and to another time.
CREATE FUNCTION gathering_schedules_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  g gatherings;
BEGIN
  SELECT * INTO g FROM gatherings WHERE id = NEW.gathering_id;
  IF g.bot_id IS DISTINCT FROM NEW.bot_id
     OR (SELECT is_house FROM bots WHERE id = NEW.bot_id)
     OR NOT EXISTS (SELECT 1 FROM api_keys
                    WHERE id = NEW.key_id AND bot_id = NEW.bot_id AND revoked_at IS NULL)
     OR NOT gathering_is_visible(g)
     OR EXISTS (SELECT 1 FROM gathering_ends e WHERE e.gathering_id = g.id)
     OR gathering_start(g) <= now()
     OR NEW.version <> gathering_version(g) + 1
     OR NEW.version > gathering_moves_max()
     OR NEW.starts_at = gathering_start(g) THEN
    RAISE EXCEPTION 'gathering % can''t move', NEW.gathering_id
      USING ERRCODE = 'UPG02';
  END IF;
  NEW.rsvps_upto := coalesce(
    (SELECT max(x.id) FROM gathering_rsvps x WHERE x.gathering_id = NEW.gathering_id), 0);
  RETURN NEW;
END;
$$;
CREATE TRIGGER gathering_schedules_check_insert BEFORE INSERT ON gathering_schedules
  FOR EACH ROW EXECUTE FUNCTION gathering_schedules_check_insert();

-- A gathering ends once, and a short end is decided on its start in force
-- (055), so a move that lands after its decision is refused above, and one
-- before it moves the decision with it.
CREATE OR REPLACE FUNCTION shorts_due(lo timestamptz, hi timestamptz)
RETURNS TABLE (gathering_id bigint, announcer bigint, decide_at timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT g.id, g.bot_id, t.starts_at - interval '15 minutes'
  FROM gathering_times(lo + interval '15 minutes', hi + interval '15 minutes') t
  JOIN gatherings g ON g.id = t.gathering_id
  WHERE g.needs IS NOT NULL
    AND gathering_is_visible(g)
    AND t.starts_at - interval '15 minutes' >= greatest(lo, event_fires_epoch())
    AND NOT EXISTS (SELECT 1 FROM gathering_ends e WHERE e.gathering_id = g.id)
    AND (SELECT count(*) FROM gathering_coming_as_of(g.id, t.starts_at - interval '15 minutes') a
         JOIN bots b ON b.id = a.bot_id
         WHERE b.frozen_at IS NULL AND NOT has_blocked(a.bot_id, g.bot_id)) < g.needs
$$;

ALTER TABLE event_fires DROP CONSTRAINT event_fires_kind_check;
ALTER TABLE event_fires ADD CONSTRAINT event_fires_kind_check
  CHECK (kind IN ('back', 'rsvp', 'session', 'short', 'start', 'moved'));

-- The due-list (076), its gathering items by the start in force, keyed by
-- its version, and the moved item.
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
    SELECT DISTINCT ON (x.bot_id) x.bot_id, x.key_id, x.notice_minutes, x.created_at
    FROM gathering_rsvps x
    WHERE x.gathering_id = g.id AND (only_bot IS NULL OR x.bot_id = only_bot)
    ORDER BY x.bot_id, x.id DESC) r
  CROSS JOIN LATERAL (
    SELECT greatest(t.starts_at - make_interval(mins => r.notice_minutes),
                    r.created_at) AS due_at) d
  JOIN bots b ON b.id = r.bot_id
  WHERE r.key_id IS NOT NULL
    AND d.due_at >= greatest(lo, event_fires_epoch())
    AND d.due_at < hi
    AND d.due_at < t.starts_at
    AND NOT EXISTS (SELECT 1 FROM gathering_ends e WHERE e.gathering_id = g.id)
    AND NOT EXISTS (
      SELECT 1 FROM event_fires f
      WHERE f.kind = 'rsvp' AND f.event_id = g.id AND f.occurrence = t.version
        AND f.bot_id = r.bot_id)
  UNION ALL
  -- At the start in force, for each bot whose RSVP in force was made before it.
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
    SELECT DISTINCT ON (x.bot_id) x.bot_id, x.key_id, x.created_at
    FROM gathering_rsvps x
    WHERE x.gathering_id = g.id AND (only_bot IS NULL OR x.bot_id = only_bot)
    ORDER BY x.bot_id, x.id DESC) r
  JOIN bots b ON b.id = r.bot_id
  WHERE r.key_id IS NOT NULL
    AND r.created_at < t.starts_at
    AND NOT EXISTS (SELECT 1 FROM gathering_ends e WHERE e.gathering_id = g.id)
    AND NOT EXISTS (
      SELECT 1 FROM event_fires f
      WHERE f.kind = 'start' AND f.event_id = g.id AND f.occurrence = t.version
        AND f.bot_id = r.bot_id)
  UNION ALL
  -- At the newest move, for each bot coming whose RSVP in force went in
  -- before it (rsvps_upto), but the announcer, which moved it. Open until
  -- the new start.
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
