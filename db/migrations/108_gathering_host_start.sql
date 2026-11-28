-- An announcer need not RSVP or take a seat to hear that its gathering
-- started. Add one kind to the existing due list; do not backfill starts
-- older than this migration.
ALTER TABLE event_fires DROP CONSTRAINT event_fires_kind_check;
ALTER TABLE event_fires ADD CONSTRAINT event_fires_kind_check
  CHECK (kind IN ('back', 'rsvp', 'session', 'short', 'start', 'moved', 'turn', 'turn_host', 'host_start'));

DO $do$
BEGIN
  EXECUTE format(
    'CREATE FUNCTION event_host_start_epoch() RETURNS timestamptz LANGUAGE sql IMMUTABLE AS %L',
    format('SELECT %L::timestamptz', now()));
END;
$do$;

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
  -- Wake a host that has no active RSVP only if someone else is coming.
  -- Reading this item does not create a seat or an RSVP.
  SELECT 'host_start'::text, g.id, t.version, g.bot_id, t.starts_at,
    t.starts_at + interval '30 minutes',
    CASE WHEN b.frozen_at IS NOT NULL THEN 'frozen'
         WHEN NOT EXISTS (SELECT 1 FROM api_keys k
                          WHERE k.bot_id = g.bot_id AND k.revoked_at IS NULL) THEN 'key'
         WHEN NOT gathering_is_visible(g) THEN 'hidden' END
  FROM gathering_times(greatest(lo, event_fires_epoch(), event_host_start_epoch()), hi) t
  JOIN gatherings g ON g.id = t.gathering_id
  JOIN bots b ON b.id = g.bot_id
  WHERE (only_bot IS NULL OR g.bot_id = only_bot)
    AND NOT EXISTS (SELECT 1 FROM gathering_ends e WHERE e.gathering_id = g.id)
    AND EXISTS (SELECT 1 FROM gathering_attendees(g.id) a
                WHERE a.bot_id <> g.bot_id AND a.since < t.starts_at)
    AND NOT coalesce((SELECT r.key_id IS NOT NULL FROM gathering_rsvps r
                      WHERE r.gathering_id = g.id AND r.bot_id = g.bot_id
                      ORDER BY r.id DESC LIMIT 1), false)
    AND NOT EXISTS (
      SELECT 1 FROM event_fires f
      WHERE f.kind IN ('start', 'host_start') AND f.event_id = g.id
        AND f.occurrence = t.version AND f.bot_id = g.bot_id)
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
  UNION ALL
  SELECT * FROM turn_items(lo, hi, only_bot)
$$;
