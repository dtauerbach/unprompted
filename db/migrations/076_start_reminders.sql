-- Two reminders for a gathering (EV5): one at the bot's notice, as before,
-- and one at its start, so a bot coming to it is woken when it begins as
-- well as ahead of it. And one wake for times that come due together: a
-- run that fires several of a bot's items raises its wake number once.
--
-- The start item: for each bot coming whose RSVP in force was made before
-- the start, due at the start, open until the gathering is over (the RSVP
-- window), skipped for the same reasons as the RSVP item. A gathering that
-- ended (cancelled or short) has none, as it has no RSVP item. Its key is
-- (start, gathering, 0, bot), so it fires once, however the RSVP or notice
-- moves. Nothing that started before this migration ran has one, so the
-- first run doesn't wake bots already at a gathering under way.
--
-- A notice of 0 had no item at all: its time is the start, and the RSVP
-- item is only for times before the start (056), so such a bot was told
-- wake_at was the start and never woken. The start item is that wake now.
--
-- One wake per run: event_fires' row trigger raised the wake number once
-- for each fired row. It's now a statement trigger that raises it once for
-- each bot with a fired row in the statement, in bot_id order, as 032's
-- lock rule asks; src/lib/due.ts writes a run's rows in one statement.
-- Every row still goes in, so a bot's `due` shows each item fired. This
-- changes no row: it replaces a trigger and adds a kind.

ALTER TABLE event_fires DROP CONSTRAINT event_fires_kind_check;
ALTER TABLE event_fires ADD CONSTRAINT event_fires_kind_check
  CHECK (kind IN ('back', 'rsvp', 'session', 'short', 'start'));

DROP TRIGGER event_fires_wake ON event_fires;
DROP FUNCTION event_fires_wake();

CREATE FUNCTION event_fires_wake() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  b bigint;
BEGIN
  FOR b IN
    SELECT DISTINCT f.bot_id FROM fresh_fires f
    WHERE f.outcome = 'fired'
    ORDER BY f.bot_id
  LOOP
    PERFORM bump_wake(b);
  END LOOP;
  RETURN NULL;
END;
$$;
CREATE TRIGGER event_fires_wake AFTER INSERT ON event_fires
  REFERENCING NEW TABLE AS fresh_fires
  FOR EACH STATEMENT EXECUTE FUNCTION event_fires_wake();

-- When this migration ran: no gathering that started before it gets a
-- start item.
DO $do$
BEGIN
  EXECUTE format(
    'CREATE FUNCTION event_start_epoch() RETURNS timestamptz LANGUAGE sql IMMUTABLE AS %L',
    format('SELECT %L::timestamptz', now()));
END;
$do$;

-- The due-list (056), with the start item beside the RSVP item.
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
  SELECT 'rsvp'::text, g.id, 0, r.bot_id,
    d.due_at,
    g.starts_at + interval '30 minutes',
    CASE WHEN b.frozen_at IS NOT NULL THEN 'frozen'
         WHEN NOT EXISTS (SELECT 1 FROM api_keys k
                          WHERE k.id = r.key_id AND k.revoked_at IS NULL) THEN 'key'
         WHEN NOT gathering_is_visible(g) THEN 'hidden'
         WHEN has_blocked(r.bot_id, g.bot_id) THEN 'blocked' END
  FROM gatherings g
  CROSS JOIN LATERAL (
    SELECT DISTINCT ON (x.bot_id) x.bot_id, x.key_id, x.notice_minutes, x.created_at
    FROM gathering_rsvps x
    WHERE x.gathering_id = g.id AND (only_bot IS NULL OR x.bot_id = only_bot)
    ORDER BY x.bot_id, x.id DESC) r
  CROSS JOIN LATERAL (
    SELECT greatest(g.starts_at - make_interval(mins => r.notice_minutes),
                    r.created_at) AS due_at) d
  JOIN bots b ON b.id = r.bot_id
  WHERE r.key_id IS NOT NULL
    AND g.starts_at >= lo AND g.starts_at < hi + interval '15 minutes'
    AND d.due_at >= greatest(lo, event_fires_epoch())
    AND d.due_at < hi
    AND d.due_at < g.starts_at
    AND NOT EXISTS (SELECT 1 FROM gathering_ends e WHERE e.gathering_id = g.id)
    AND NOT EXISTS (
      SELECT 1 FROM event_fires f
      WHERE f.kind = 'rsvp' AND f.event_id = g.id AND f.occurrence = 0
        AND f.bot_id = r.bot_id)
  UNION ALL
  -- At the start, for each bot whose RSVP in force was made before it.
  SELECT 'start'::text, g.id, 0, r.bot_id,
    g.starts_at,
    g.starts_at + interval '30 minutes',
    CASE WHEN b.frozen_at IS NOT NULL THEN 'frozen'
         WHEN NOT EXISTS (SELECT 1 FROM api_keys k
                          WHERE k.id = r.key_id AND k.revoked_at IS NULL) THEN 'key'
         WHEN NOT gathering_is_visible(g) THEN 'hidden'
         WHEN has_blocked(r.bot_id, g.bot_id) THEN 'blocked' END
  FROM gatherings g
  CROSS JOIN LATERAL (
    SELECT DISTINCT ON (x.bot_id) x.bot_id, x.key_id, x.created_at
    FROM gathering_rsvps x
    WHERE x.gathering_id = g.id AND (only_bot IS NULL OR x.bot_id = only_bot)
    ORDER BY x.bot_id, x.id DESC) r
  JOIN bots b ON b.id = r.bot_id
  WHERE r.key_id IS NOT NULL
    AND r.created_at < g.starts_at
    AND g.starts_at >= greatest(lo, event_fires_epoch(), event_start_epoch())
    AND g.starts_at < hi
    AND NOT EXISTS (SELECT 1 FROM gathering_ends e WHERE e.gathering_id = g.id)
    AND NOT EXISTS (
      SELECT 1 FROM event_fires f
      WHERE f.kind = 'start' AND f.event_id = g.id AND f.occurrence = 0
        AND f.bot_id = r.bot_id)
  UNION ALL
  SELECT 'short'::text, g.id, 0, a.bot_id,
    g.starts_at - interval '15 minutes',
    g.starts_at + interval '30 minutes',
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
    AND g.starts_at - interval '15 minutes' >= greatest(lo, event_fires_epoch())
    AND g.starts_at - interval '15 minutes' < hi
    AND NOT EXISTS (
      SELECT 1 FROM event_fires f
      WHERE f.kind = 'short' AND f.event_id = g.id AND f.occurrence = 0
        AND f.bot_id = a.bot_id)
  UNION ALL
  SELECT * FROM session_items(lo, hi, only_bot, false)
$$;
