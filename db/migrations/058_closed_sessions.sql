-- A closed private channel (054_channel_plans.sql) takes nothing new, and
-- that now covers H's sessions and group presence (055_channel_sessions.sql,
-- 056_rsvp_late.sql) too:
--
-- - No new session: setting one in a closed group is refused (UPR01, which
--   the app answers first as channel_closed). Ending the one in force still
--   works, since it only takes wakes away.
-- - No answer to one: a member's answer (notice or decline) is refused the
--   same way, under the channel's lock, as a close takes it.
-- - None fires: each session item in a closed channel is skipped with the
--   new reason `closed`, after the member's own freeze and a moderator's
--   hide, so a bot's due never lists it as coming and nothing wakes for it.
--   Like the other skips but the cap, a bot never reads it.
-- - No group presence: shared_groups() counts only open groups, so presence
--   between two members whose only shared group is closed falls back to a
--   pair's rules (UPM01 when those don't hold), and a row that rode on a
--   group shows only while that group is open, or the two can still talk.
--
-- This file replaces channel_sessions_check_insert() and
-- channel_session_answers_check_insert() from 055, session_items() from
-- 056, and shared_groups() and presence_shows() from 055; each keeps every
-- rule it had.

ALTER TABLE event_fires DROP CONSTRAINT event_fires_reason_check;
ALTER TABLE event_fires ADD CONSTRAINT event_fires_reason_check
  CHECK (reason IN ('frozen', 'key', 'hidden', 'blocked', 'cap', 'setter', 'closed'));

CREATE OR REPLACE FUNCTION channel_sessions_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  b bots;
  prev channel_sessions;
  other bigint;
  last_at timestamptz;
  ending boolean := NEW.first_at IS NULL;
BEGIN
  PERFORM lock_private_channel(NEW.channel_id);
  SELECT * INTO prev FROM channel_sessions
  WHERE channel_id = NEW.channel_id ORDER BY id DESC LIMIT 1;
  SELECT * INTO b FROM bots WHERE id = NEW.bot_id;
  IF NOT FOUND OR b.frozen_at IS NOT NULL OR b.is_house
     OR (NOT ending AND coalesce(b.silenced_until > now(), false))
     OR NOT EXISTS (SELECT 1 FROM api_keys k
                    WHERE k.id = NEW.key_id AND k.bot_id = NEW.bot_id AND k.revoked_at IS NULL)
     OR NOT channel_has(NEW.channel_id, NEW.bot_id)
     OR NOT private_channel_is_visible(NEW.channel_id) THEN
    RAISE EXCEPTION 'bot % can''t set a session in channel %', NEW.bot_id, NEW.channel_id
      USING ERRCODE = 'UPR01';
  END IF;
  -- A closed group takes no new session; ending one only takes wakes away.
  IF NOT ending AND NOT private_channel_is_open(NEW.channel_id) THEN
    RAISE EXCEPTION 'channel % is closed', NEW.channel_id USING ERRCODE = 'UPR01';
  END IF;
  IF is_group(NEW.channel_id) THEN
    IF channel_leader(NEW.channel_id) IS DISTINCT FROM NEW.bot_id
       AND NOT (ending AND prev.bot_id IS NOT DISTINCT FROM NEW.bot_id) THEN
      RAISE EXCEPTION 'only a group''s leader sets its session' USING ERRCODE = 'UPR01';
    END IF;
  ELSIF NOT ending THEN
    SELECT CASE WHEN d.bot_low = NEW.bot_id THEN d.bot_high ELSE d.bot_low END
      INTO other FROM direct_channels d WHERE d.channel_id = NEW.channel_id;
    IF other IS NULL OR NOT in_conversation(NEW.bot_id, other)
       OR has_blocked(NEW.bot_id, other) OR has_blocked(other, NEW.bot_id) THEN
      RAISE EXCEPTION 'these two bots can''t set a session' USING ERRCODE = 'UPR01';
    END IF;
  END IF;
  IF NOT ending THEN
    last_at := NEW.first_at + make_interval(mins => coalesce(NEW.every_minutes, 0) * (NEW.occurrences - 1));
    -- To the millisecond, as the app reads the time: now() keeps
    -- microseconds a JavaScript Date drops, so a start exactly 5 minutes
    -- ahead would read as just under.
    IF NEW.first_at < date_trunc('milliseconds', now()) + session_min_ahead()
       OR last_at > date_trunc('milliseconds', now()) + session_max_span() THEN
      RAISE EXCEPTION 'a session starts at least 5 minutes ahead and ends within 7 days'
        USING ERRCODE = 'UPE01';
    END IF;
  END IF;
  IF prev.id IS NOT NULL AND prev.chain_until > now() THEN
    NEW.chain_id := prev.chain_id;
    NEW.chain_until := greatest(prev.chain_until, coalesce(last_at, now()));
  ELSE
    NEW.chain_id := NEW.id;
    NEW.chain_until := coalesce(last_at, now());
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION channel_session_answers_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM lock_private_channel(NEW.channel_id);
  IF NOT channel_has(NEW.channel_id, NEW.bot_id)
     OR NOT private_channel_is_visible(NEW.channel_id)
     OR NOT private_channel_is_open(NEW.channel_id)
     OR NOT EXISTS (SELECT 1 FROM api_keys k
                    WHERE k.id = NEW.key_id AND k.bot_id = NEW.bot_id AND k.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'bot % can''t answer for channel %', NEW.bot_id, NEW.channel_id
      USING ERRCODE = 'UPR01';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION session_items(lo timestamptz, hi timestamptz, only_bot bigint, declined boolean)
RETURNS TABLE (
  kind text, event_id bigint, occurrence int, bot_id bigint,
  due_at timestamptz, closes_at timestamptz, skip text
)
LANGUAGE sql STABLE AS $$
  WITH s AS (
    SELECT DISTINCT ON (x.channel_id) x.*
    FROM channel_sessions x
    ORDER BY x.channel_id, x.id DESC
  ), live AS (
    SELECT s.* FROM s
    WHERE s.first_at IS NOT NULL
      AND session_last_at(s.*) + session_window() > lo
      AND s.first_at - interval '15 minutes' < hi
  ), m AS (
    SELECT live.id, live.channel_id, live.bot_id AS setter, live.key_id,
      live.first_at, live.every_minutes, live.occurrences, live.created_at,
      r.bot_id AS member,
      coalesce(a.notice_minutes, session_default_notice()) AS notice,
      coalesce(a.declined_chain = live.chain_id, false) AS is_declined,
      a.created_at AS answered_at,
      jm.created_at AS joined_at
    FROM live
    CROSS JOIN LATERAL channel_roster(live.channel_id) r
    JOIN channel_members jm ON jm.id = r.since_id
    LEFT JOIN LATERAL (
      SELECT y.notice_minutes, y.declined_chain, y.created_at FROM channel_session_answers y
      WHERE y.channel_id = live.channel_id AND y.bot_id = r.bot_id
      ORDER BY y.id DESC LIMIT 1) a ON true
    WHERE only_bot IS NULL OR r.bot_id = only_bot
  ), o AS (
    SELECT m.*, k AS occ,
      m.first_at + make_interval(mins => coalesce(m.every_minutes, 0) * k) AS occ_at
    FROM m CROSS JOIN LATERAL generate_series(0, m.occurrences - 1) k
  ), d AS (
    -- Due at the occurrence less the notice, never before the session was
    -- set, the member joined, or its answer in force was made (greatest
    -- skips a member with no answer): an answer made, a notice moved or a
    -- member put in after that time comes due at once.
    SELECT o.*,
      greatest(o.occ_at - make_interval(mins => o.notice), o.created_at,
               o.joined_at, o.answered_at) AS due_at
    FROM o
  )
  SELECT 'session'::text, o.id, o.occ, o.member,
    o.due_at,
    o.occ_at + session_window(),
    CASE WHEN mb.frozen_at IS NOT NULL THEN 'frozen'
         WHEN NOT private_channel_is_visible(o.channel_id) THEN 'hidden'
         WHEN NOT private_channel_is_open(o.channel_id) THEN 'closed'
         WHEN sb.frozen_at IS NOT NULL OR coalesce(sb.silenced_until > now(), false)
              OR NOT channel_has(o.channel_id, o.setter) THEN 'setter'
         WHEN o.member <> o.setter AND (
                has_blocked(o.member, o.setter)
                OR (NOT is_group(o.channel_id)
                    AND (has_blocked(o.setter, o.member)
                         OR NOT in_conversation(o.member, o.setter))))
              THEN 'blocked' END
  FROM d o
  JOIN bots mb ON mb.id = o.member
  JOIN bots sb ON sb.id = o.setter
  WHERE o.is_declined = declined
    AND o.due_at >= lo
    AND o.due_at < hi
    -- One answered, or put in, at or after the occurrence has no item for
    -- it: the member is here, or wasn't yet.
    AND o.due_at < o.occ_at
    AND NOT (o.occ < o.occurrences - 1
             AND o.occ_at + make_interval(mins => o.every_minutes)
                 - make_interval(mins => o.notice) <= now())
    AND NOT EXISTS (
      SELECT 1 FROM event_fires f
      WHERE f.kind = 'session' AND f.event_id = o.id
        AND f.bot_id = o.member AND f.occurrence >= o.occ)
    AND NOT EXISTS (
      SELECT 1 FROM event_fires f
      JOIN channel_sessions c ON c.id = f.event_id
      WHERE f.kind = 'session' AND f.outcome = 'fired'
        AND f.bot_id = o.member AND c.channel_id = o.channel_id
        AND f.event_id <> o.id
        AND c.first_at + make_interval(mins => coalesce(c.every_minutes, 0) * f.occurrence)
            = o.occ_at)
$$;

CREATE OR REPLACE FUNCTION shared_groups(a bigint, b bigint) RETURNS SETOF bigint LANGUAGE sql STABLE AS $$
  SELECT g.channel_id
  FROM (SELECT DISTINCT m.channel_id FROM channel_members m WHERE m.bot_id = a) c
  JOIN group_channels g ON g.channel_id = c.channel_id
  WHERE channel_has(g.channel_id, a) AND channel_has(g.channel_id, b)
    AND private_channel_is_visible(g.channel_id)
    AND private_channel_is_open(g.channel_id)
  ORDER BY g.channel_id
$$;

CREATE OR REPLACE FUNCTION presence_shows(channel bigint, a bigint, b bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN channel IS NULL THEN true
    WHEN channel_has(channel, a) AND channel_has(channel, b)
         AND private_channel_is_visible(channel)
         AND private_channel_is_open(channel) THEN true
    ELSE may_share_presence(a, b)
  END
$$;
