-- An RSVP made after its notice time, or a notice moved earlier than now,
-- comes due when its row was made, so it fires at once, while the gathering
-- hasn't started; one made at or after the start has no item, and its answer
-- says no wake is coming. 052 dropped such an RSVP instead, so a bot that
-- said it was coming, late or with a new notice, was never woken. An item is
-- still keyed by (kind, Event, occurrence, bot), so saying it again or moving
-- the notice once it fired fires nothing more, and every fire still counts
-- against the site-wide cap.
--
-- A session's answer takes the same rule (055_channel_sessions.sql): an
-- answer made, or a notice moved, after an occurrence's notice time comes
-- due when it was made, so the member is woken at once while the occurrence
-- hasn't come; one made at or after the occurrence has no item for it.
-- Before, a late answer's item kept its earlier time and fired at the next
-- run, even after the channel had met. Joining takes the same rule: a
-- member's item is never due before its membership in force began (the
-- created_at of its channel_members row, which channel_roster() gives as
-- since_id; a member can't be added again while in, so that row is when it
-- joined), so an occurrence at or before the join has no item for it, and
-- one whose notice time had passed when it joined comes due at the join.
--
-- This file replaces session_items() and due_items() from 055 and keeps all
-- of 055's items (sessions, short ends); only the RSVP item and a late
-- answer's time change.

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

-- The due-list (055), its RSVP item due at its notice, or when its row was
-- made if that's later.
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
  -- Due at its notice, or when the row was made if that's later: an RSVP
  -- made, or a notice moved, after its notice time comes due at once.
  CROSS JOIN LATERAL (
    SELECT greatest(g.starts_at - make_interval(mins => r.notice_minutes),
                    r.created_at) AS due_at) d
  JOIN bots b ON b.id = r.bot_id
  WHERE r.key_id IS NOT NULL
    -- Notice is at most 15 minutes, and a late item is due before the
    -- start: a bound the starts_at index can use.
    AND g.starts_at >= lo AND g.starts_at < hi + interval '15 minutes'
    AND d.due_at >= greatest(lo, event_fires_epoch())
    AND d.due_at < hi
    -- One made at or after the start has no item: the bot is here.
    AND d.due_at < g.starts_at
    AND NOT EXISTS (SELECT 1 FROM gathering_ends e WHERE e.gathering_id = g.id)
    AND NOT EXISTS (
      SELECT 1 FROM event_fires f
      WHERE f.kind = 'rsvp' AND f.event_id = g.id AND f.occurrence = 0
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
