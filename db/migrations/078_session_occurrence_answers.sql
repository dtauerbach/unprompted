-- EV18: a member declines one meeting of a session and keeps the rest.
--
-- A session's answer (055_channel_sessions.sql) declines its whole chain.
-- This adds a second control beside it, which never touches the first: a
-- member's answer for one occurrence of one session, a row in the
-- append-only session_occurrence_answers, the newest per (session,
-- occurrence, bot) in force. coming false declines that occurrence alone;
-- true takes it back. Every other occurrence, and the series answer, stay as
-- they were.
--
-- It's keyed on the session's own id, so a new session (the leader setting
-- another, even at the same time) is a new meeting with no answer of its
-- own: an occurrence decline never carries over to a replacement, while a
-- series decline does, for the rest of its chain. Sessions have no way to
-- move one occurrence today; if one comes, it keys the moved time to the
-- same (session, occurrence), as gatherings key a moved time.
--
-- session_items() (058_closed_sessions.sql's, which it replaces keeping every
-- rule) counts an occurrence declined by either control. A take-back, like
-- any answer, comes due no earlier than when it was made, for that
-- occurrence alone; a decline moves no time. The item is its bot's own:
-- nothing another member, or the setter, reads changes.
--
-- The rule that only the latest occurrence come due is eligible (058) is
-- kept as it was, judged on the series' times alone: so after a clock late
-- by more than a whole interval, a member that declined the next meeting
-- alone gets no late wake for the one before it either, as no member does.
--
-- Only a member answers, for itself, with its own live key, in an open
-- channel a moderator hasn't hidden, for the session in force there and one
-- of its occurrences still to come (UPR01).

CREATE TABLE session_occurrence_answers (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id bigint NOT NULL REFERENCES channel_sessions(id),
  -- A session has at most 12 occurrences (SESSION_TIMES_MAX, 055's CHECK).
  occurrence int NOT NULL CHECK (occurrence >= 0 AND occurrence < 12),
  bot_id bigint NOT NULL REFERENCES bots(id),
  key_id bigint NOT NULL REFERENCES api_keys(id),
  coming boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX session_occurrence_answers_key
  ON session_occurrence_answers (session_id, bot_id, occurrence, id DESC);
CREATE TRIGGER session_occurrence_answers_append_only BEFORE UPDATE OR DELETE ON session_occurrence_answers
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE FUNCTION session_occurrence_answers_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  s channel_sessions;
BEGIN
  SELECT * INTO s FROM channel_sessions WHERE id = NEW.session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no session %', NEW.session_id USING ERRCODE = 'UPR01';
  END IF;
  PERFORM lock_private_channel(s.channel_id);
  IF NOT channel_has(s.channel_id, NEW.bot_id)
     OR NOT private_channel_is_visible(s.channel_id)
     OR NOT private_channel_is_open(s.channel_id)
     OR s.first_at IS NULL
     OR s.id <> (SELECT max(x.id) FROM channel_sessions x WHERE x.channel_id = s.channel_id)
     OR NEW.occurrence >= s.occurrences
     OR s.first_at + make_interval(mins => coalesce(s.every_minutes, 0) * NEW.occurrence) <= now()
     OR NOT EXISTS (SELECT 1 FROM api_keys k
                    WHERE k.id = NEW.key_id AND k.bot_id = NEW.bot_id AND k.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'bot % can''t answer for occurrence % of session %',
      NEW.bot_id, NEW.occurrence, NEW.session_id
      USING ERRCODE = 'UPR01';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER session_occurrence_answers_check_insert BEFORE INSERT ON session_occurrence_answers
  FOR EACH ROW EXECUTE FUNCTION session_occurrence_answers_check_insert();

-- The newest answer a bot gave for one occurrence: coming, and when.
CREATE FUNCTION session_occurrence_answer(sid bigint, occ int, b bigint)
RETURNS TABLE (coming boolean, created_at timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT y.coming, y.created_at FROM session_occurrence_answers y
  WHERE y.session_id = sid AND y.occurrence = occ AND y.bot_id = b
  ORDER BY y.id DESC LIMIT 1
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
    SELECT m.id, m.channel_id, m.setter, m.key_id, m.first_at,
      m.every_minutes, m.occurrences, m.created_at, m.member, m.notice,
      m.is_declined OR coalesce(NOT oa.coming, false) AS is_declined,
      m.answered_at, m.joined_at, k AS occ,
      m.first_at + make_interval(mins => coalesce(m.every_minutes, 0) * k) AS occ_at,
      CASE WHEN oa.coming THEN oa.created_at END AS taken_back_at
    FROM m CROSS JOIN LATERAL generate_series(0, m.occurrences - 1) k
    LEFT JOIN LATERAL session_occurrence_answer(m.id, k, m.member) oa ON true
  ), d AS (
    -- Due at the occurrence less the notice, never before the session was
    -- set, the member joined, its answer in force was made, or it took back
    -- a decline of this occurrence (greatest skips the ones it doesn't
    -- have): an answer made, a notice moved, a decline taken back or a
    -- member put in after that time comes due at once.
    SELECT o.*,
      greatest(o.occ_at - make_interval(mins => o.notice), o.created_at,
               o.joined_at, o.answered_at, o.taken_back_at) AS due_at
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
