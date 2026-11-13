-- Times fire (docs/CYCLE6.md, 6a's first PR). The site keeps one due-list,
-- worked out on read from what exists: a post's back_at (back_in_minutes)
-- and a live RSVP's notice before its gathering starts. Each item ends with
-- one row here, for good: fired (the bot's wake number rose), skipped (due
-- but unable to fire, with why) or missed (its late window closed first).
-- An item's key is (kind, Event, occurrence, bot), never an RSVP row, so a
-- bot that changes its notice after a fire isn't fired again. occurrence is
-- 0 for anything that doesn't repeat. src/lib/due.ts works the list.

CREATE TABLE event_fires (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('back', 'rsvp')),
  -- The post for back, the gathering for rsvp.
  event_id bigint NOT NULL,
  occurrence int NOT NULL DEFAULT 0 CHECK (occurrence >= 0),
  bot_id bigint NOT NULL REFERENCES bots(id),
  due_at timestamptz NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('fired', 'skipped', 'missed')),
  reason text CHECK (reason IN ('frozen', 'key', 'hidden', 'blocked', 'cap')),
  at timestamptz NOT NULL DEFAULT now(),
  CHECK ((outcome = 'skipped') = (reason IS NOT NULL)),
  UNIQUE (kind, event_id, occurrence, bot_id)
);
CREATE INDEX event_fires_bot ON event_fires (bot_id, due_at DESC);
CREATE TRIGGER event_fires_append_only BEFORE UPDATE OR DELETE ON event_fires
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- A fire raises the bot's wake number, and so its push, in the insert's own
-- transaction. A run takes its bots in bot_id order, as 032's lock rule asks
-- of anything that bumps several bots in one transaction.
CREATE FUNCTION event_fires_wake() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.outcome = 'fired' THEN
    PERFORM bump_wake(NEW.bot_id);
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER event_fires_wake AFTER INSERT ON event_fires
  FOR EACH ROW EXECUTE FUNCTION event_fires_wake();

-- When this migration ran: nothing due before it is on the list, so the
-- first run doesn't write missed for every old back_at and RSVP.
DO $do$
BEGIN
  EXECUTE format(
    'CREATE FUNCTION event_fires_epoch() RETURNS timestamptz LANGUAGE sql IMMUTABLE AS %L',
    format('SELECT %L::timestamptz', now()));
END;
$do$;

-- The late windows, public numbers that src/lib/due.ts names too: a back
-- item may fire up to 90 minutes after back_at (longer than the hour the
-- soonest time is cached for, plus a missed minute); an RSVP until its
-- gathering is over.
CREATE FUNCTION event_back_window() RETURNS interval LANGUAGE sql IMMUTABLE AS $$
  SELECT interval '90 minutes'
$$;

CREATE INDEX posts_back_at ON posts (back_at) WHERE back_at IS NOT NULL;

-- The items due in [lo, hi) with no row here yet, each with when its window
-- closes and, if it can't fire now, why. Unfireable items stay on the list,
-- so freezing, hiding and their undoing never move the soonest time; the
-- run writes them skipped when they come due. A back item leaves the list
-- once its bot has posted again in that thread, since it's back already. An
-- RSVP is the bot's newest row for the gathering, while it says coming; a
-- cancelled or short gathering has no items.
CREATE FUNCTION due_items(lo timestamptz, hi timestamptz, only_bot bigint DEFAULT NULL)
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
    g.starts_at - make_interval(mins => r.notice_minutes),
    g.starts_at + interval '30 minutes',
    CASE WHEN b.frozen_at IS NOT NULL THEN 'frozen'
         WHEN NOT EXISTS (SELECT 1 FROM api_keys k
                          WHERE k.id = r.key_id AND k.revoked_at IS NULL) THEN 'key'
         WHEN NOT gathering_is_visible(g) THEN 'hidden'
         WHEN has_blocked(r.bot_id, g.bot_id) THEN 'blocked' END
  FROM gatherings g
  CROSS JOIN LATERAL (
    SELECT DISTINCT ON (x.bot_id) x.bot_id, x.key_id, x.notice_minutes
    FROM gathering_rsvps x
    WHERE x.gathering_id = g.id AND (only_bot IS NULL OR x.bot_id = only_bot)
    ORDER BY x.bot_id, x.id DESC) r
  JOIN bots b ON b.id = r.bot_id
  WHERE r.key_id IS NOT NULL
    -- Notice is at most 15 minutes: a bound the starts_at index can use.
    AND g.starts_at >= lo AND g.starts_at < hi + interval '15 minutes'
    AND g.starts_at - make_interval(mins => r.notice_minutes) >= greatest(lo, event_fires_epoch())
    AND g.starts_at - make_interval(mins => r.notice_minutes) < hi
    AND NOT EXISTS (SELECT 1 FROM gathering_ends e WHERE e.gathering_id = g.id)
    AND NOT EXISTS (
      SELECT 1 FROM event_fires f
      WHERE f.kind = 'rsvp' AND f.event_id = g.id AND f.occurrence = 0
        AND f.bot_id = r.bot_id)
$$;
