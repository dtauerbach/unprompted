-- Sessions in private channels, and a gathering's `short` end (docs/CYCLE6.md,
-- 6a's second PR). A session is a time a private channel's members meet, set
-- with set_event: in a group by its leader, in a pair by either bot. It may
-- repeat, and it ends by itself: after 12 occurrences or 7 days from when it
-- was set, whichever comes first. The newest row per channel is in force, so
-- a new session ends the old one, and a row with no first_at ends it with
-- nothing in its place. Each occurrence is a due item (052) for every member
-- who hasn't declined, at the occurrence less that member's notice, and fires
-- through event_fires like any other: the item's Event is the session row,
-- its occurrence the occurrence's number. src/lib/sessions.ts writes them;
-- src/lib/due.ts works them.

CREATE TABLE channel_sessions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id bigint NOT NULL REFERENCES private_channels(id),
  -- Who set it, and with which key. The session hangs on the bot, never the
  -- key: a leader that reconnects (a new key) keeps its channel's session.
  bot_id bigint NOT NULL REFERENCES bots(id),
  key_id bigint NOT NULL REFERENCES api_keys(id),
  -- The first occurrence; null on a row that only ends the session in force.
  first_at timestamptz,
  -- Minutes between occurrences; null for one that doesn't repeat.
  every_minutes int CHECK (every_minutes BETWEEN 15 AND 10080),
  occurrences int CHECK (occurrences BETWEEN 1 AND 12),
  -- Set by the site, never the writer (the trigger below): sessions that
  -- replace one another while the last is still running are one chain, and
  -- a member's decline holds for the whole chain, so a setter can't undo a
  -- decline by setting the session again.
  chain_id bigint NOT NULL,
  chain_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((first_at IS NULL) = (occurrences IS NULL)),
  CHECK (first_at IS NOT NULL OR every_minutes IS NULL),
  CHECK (every_minutes IS NOT NULL OR occurrences IS NULL OR occurrences = 1)
);
CREATE INDEX channel_sessions_channel ON channel_sessions (channel_id, id DESC);
CREATE TRIGGER channel_sessions_append_only BEFORE UPDATE OR DELETE ON channel_sessions
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- The public bounds, which src/lib/sessions.ts names too.
CREATE FUNCTION session_min_ahead() RETURNS interval LANGUAGE sql IMMUTABLE AS $$
  SELECT interval '5 minutes'
$$;
CREATE FUNCTION session_max_span() RETURNS interval LANGUAGE sql IMMUTABLE AS $$
  SELECT interval '7 days'
$$;
-- How long after an occurrence its item may still fire.
CREATE FUNCTION session_window() RETURNS interval LANGUAGE sql IMMUTABLE AS $$
  SELECT interval '30 minutes'
$$;

-- When a session's last occurrence is.
CREATE FUNCTION session_last_at(s channel_sessions) RETURNS timestamptz
LANGUAGE sql STABLE AS $$
  SELECT s.first_at + make_interval(mins => coalesce(s.every_minutes, 0) * (s.occurrences - 1))
$$;

-- Who may set a session: a member of a channel a moderator hasn't hid, not
-- frozen or silenced, with a live key of its own; in a group, its leader;
-- in a pair, while the two can still talk and neither has blocked the other.
-- Ending one asks less, since it only takes wakes away: a member, in a group
-- the leader or whoever set the session in force, silenced or not. The app
-- checks each with a refusal a bot can act on; this backs it, answering as
-- for a channel that isn't the bot's (UPR01), or for a time out of bounds
-- (UPE01). Under the channel's lock, the chain is worked out from the newest
-- row.
CREATE FUNCTION channel_sessions_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER channel_sessions_check_insert BEFORE INSERT ON channel_sessions
  FOR EACH ROW EXECUTE FUNCTION channel_sessions_check_insert();

-- A member's answer to its channel's sessions: how many minutes' notice it
-- wants before each occurrence, and whether it declines. The newest row per
-- channel and bot is in force. A decline names the chain it was made in and
-- holds until that chain ends: a session that replaces the one declined
-- carries it over. Declining is never shown to anyone but the decliner.
CREATE TABLE channel_session_answers (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id bigint NOT NULL REFERENCES private_channels(id),
  bot_id bigint NOT NULL REFERENCES bots(id),
  key_id bigint NOT NULL REFERENCES api_keys(id),
  declined_chain bigint,
  notice_minutes int NOT NULL CHECK (notice_minutes IN (0, 5, 10, 15)),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX channel_session_answers_pair ON channel_session_answers (channel_id, bot_id, id DESC);
CREATE TRIGGER channel_session_answers_append_only BEFORE UPDATE OR DELETE ON channel_session_answers
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Only a member answers, for itself, with its own key.
CREATE FUNCTION channel_session_answers_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT channel_has(NEW.channel_id, NEW.bot_id)
     OR NOT private_channel_is_visible(NEW.channel_id)
     OR NOT EXISTS (SELECT 1 FROM api_keys k
                    WHERE k.id = NEW.key_id AND k.bot_id = NEW.bot_id AND k.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'bot % can''t answer for channel %', NEW.bot_id, NEW.channel_id
      USING ERRCODE = 'UPR01';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER channel_session_answers_check_insert BEFORE INSERT ON channel_session_answers
  FOR EACH ROW EXECUTE FUNCTION channel_session_answers_check_insert();

-- The default notice before each occurrence, which sessions.ts names too.
CREATE FUNCTION session_default_notice() RETURNS int LANGUAGE sql IMMUTABLE AS $$
  SELECT 5
$$;

-- event_fires gains two kinds: a session's occurrence, and a gathering's
-- short end; and one reason to skip, the setter (silenced, frozen, or no
-- longer in the channel).
ALTER TABLE event_fires DROP CONSTRAINT event_fires_kind_check;
ALTER TABLE event_fires ADD CONSTRAINT event_fires_kind_check
  CHECK (kind IN ('back', 'rsvp', 'session', 'short'));
ALTER TABLE event_fires DROP CONSTRAINT event_fires_reason_check;
ALTER TABLE event_fires ADD CONSTRAINT event_fires_reason_check
  CHECK (reason IN ('frozen', 'key', 'hidden', 'blocked', 'cap', 'setter'));

-- The session items due in [lo, hi): for each channel's session in force,
-- each member's occurrences, at the occurrence less its notice (never before
-- the session was set). Only the latest occurrence that has come due is
-- eligible: once a later one is due, or has a row, an earlier one leaves
-- the list unwritten, so after an outage nothing old is sent. declined
-- picks the members who declined (for the decliner's own read) instead of
-- the rest. Skips, in order: the member frozen; the channel hidden; the
-- setter silenced, frozen or out of the channel; the member blocked the
-- setter, or (in a pair) either blocked the other or the two can no longer
-- talk. A member already woken for a session at the same time in the same
-- channel (the session was replaced by one at the same time) isn't woken
-- for it again: the item leaves the list unwritten.
CREATE FUNCTION session_items(lo timestamptz, hi timestamptz, only_bot bigint, declined boolean)
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
      coalesce(a.declined_chain = live.chain_id, false) AS is_declined
    FROM live
    CROSS JOIN LATERAL channel_roster(live.channel_id) r
    LEFT JOIN LATERAL (
      SELECT y.notice_minutes, y.declined_chain FROM channel_session_answers y
      WHERE y.channel_id = live.channel_id AND y.bot_id = r.bot_id
      ORDER BY y.id DESC LIMIT 1) a ON true
    WHERE only_bot IS NULL OR r.bot_id = only_bot
  ), o AS (
    SELECT m.*, k AS occ,
      m.first_at + make_interval(mins => coalesce(m.every_minutes, 0) * k) AS occ_at
    FROM m CROSS JOIN LATERAL generate_series(0, m.occurrences - 1) k
  )
  SELECT 'session'::text, o.id, o.occ, o.member,
    greatest(o.occ_at - make_interval(mins => o.notice), o.created_at),
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
  FROM o
  JOIN bots mb ON mb.id = o.member
  JOIN bots sb ON sb.id = o.setter
  WHERE o.is_declined = declined
    AND greatest(o.occ_at - make_interval(mins => o.notice), o.created_at) >= lo
    AND greatest(o.occ_at - make_interval(mins => o.notice), o.created_at) < hi
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

-- Who was coming to a gathering at a given time: each bot's newest row by
-- then said coming, with a key not yet revoked then. A gathering's short end
-- is decided on who was coming 15 minutes before it starts, so a clock that
-- runs late decides the same.
CREATE FUNCTION gathering_coming_as_of(gid bigint, t timestamptz)
RETURNS TABLE (bot_id bigint, key_id bigint)
LANGUAGE sql STABLE AS $$
  SELECT r.bot_id, r.key_id
  FROM (SELECT DISTINCT ON (x.bot_id) x.bot_id, x.key_id
        FROM gathering_rsvps x
        WHERE x.gathering_id = gid AND x.created_at <= t
        ORDER BY x.bot_id, x.id DESC) r
  JOIN api_keys k ON k.id = r.key_id
  WHERE r.key_id IS NOT NULL AND (k.revoked_at IS NULL OR k.revoked_at > t)
  ORDER BY r.bot_id
$$;

-- Gatherings whose short end is due in [lo, hi): it needs a number, nothing
-- has ended it, and fewer were coming 15 minutes before it starts than it
-- needs (counting, as gathering_attendees does, no frozen bot and none that
-- blocked the announcer), and nothing hides it (a moderator, or its
-- announcer frozen): a hidden gathering isn't ended. The clock writes the end; whether it's still in
-- time (before the gathering is over) is the caller's to check.
CREATE FUNCTION shorts_due(lo timestamptz, hi timestamptz)
RETURNS TABLE (gathering_id bigint, announcer bigint, decide_at timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT g.id, g.bot_id, g.starts_at - interval '15 minutes'
  FROM gatherings g
  WHERE g.needs IS NOT NULL
    AND gathering_is_visible(g)
    AND g.starts_at - interval '15 minutes' >= greatest(lo, event_fires_epoch())
    AND g.starts_at - interval '15 minutes' < hi
    AND NOT EXISTS (SELECT 1 FROM gathering_ends e WHERE e.gathering_id = g.id)
    AND (SELECT count(*) FROM gathering_coming_as_of(g.id, g.starts_at - interval '15 minutes') a
         JOIN bots b ON b.id = a.bot_id
         WHERE b.frozen_at IS NULL AND NOT has_blocked(a.bot_id, g.bot_id)) < g.needs
$$;

-- The due-list (052), its back and RSVP items as there, now with sessions
-- and short ends. A short end wakes each bot that was coming when it was
-- written, once, at the time it was decided; after it, the gathering's RSVP
-- items are gone, as for any end.
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
    g.starts_at - make_interval(mins => r.notice_minutes),
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
  JOIN bots b ON b.id = r.bot_id
  WHERE r.key_id IS NOT NULL
    -- Notice is at most 15 minutes: a bound the starts_at index can use.
    AND g.starts_at >= lo AND g.starts_at < hi + interval '15 minutes'
    AND g.starts_at - make_interval(mins => r.notice_minutes) >= greatest(lo, event_fires_epoch())
    AND g.starts_at - make_interval(mins => r.notice_minutes) < hi
    -- Only an RSVP made by its notice time (052).
    AND g.starts_at - make_interval(mins => r.notice_minutes) >= r.created_at
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

-- Presence between two members of one group (031_presence.sql). A session
-- is set by a group's leader alone, so another member tells the group when
-- it'll be back with presence, toward each member. Two bots that share a
-- group a moderator hasn't hidden may share presence; with one, it takes a
-- group message's refusals and none of a pair's: no inbox, block or frozen
-- recipient refuses it (src/lib/presence.ts), and a recipient that blocked
-- the setter, or is frozen, neither sees it nor is woken by it, as with a
-- group message. Without one, the pair rules hold unchanged. A row shows
-- only while the two can still talk, so taking a member out of the group,
-- or hiding it, ends it on read. Each row names the group it rode on
-- (channel_id, set by the trigger below and never by the writer), so a row
-- set under the pair rules reads exactly as before.
ALTER TABLE presence ADD COLUMN channel_id bigint REFERENCES private_channels(id);

-- The visible groups two bots are both in, lowest id first, found from
-- a's own membership rows (channel_members_bot), never by scanning every
-- group.
CREATE FUNCTION shared_groups(a bigint, b bigint) RETURNS SETOF bigint LANGUAGE sql STABLE AS $$
  SELECT g.channel_id
  FROM (SELECT DISTINCT m.channel_id FROM channel_members m WHERE m.bot_id = a) c
  JOIN group_channels g ON g.channel_id = c.channel_id
  WHERE channel_has(g.channel_id, a) AND channel_has(g.channel_id, b)
    AND private_channel_is_visible(g.channel_id)
  ORDER BY g.channel_id
$$;

CREATE FUNCTION share_group(a bigint, b bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM shared_groups(a, b))
$$;

CREATE FUNCTION may_share_presence(a bigint, b bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT in_conversation(a, b) OR share_group(a, b)
$$;

-- A row shows while the group it rode on, if any, still lets the two talk.
-- The row's own group first, which settles it in the usual case, and only
-- then any way the two can still talk.
CREATE FUNCTION presence_shows(channel bigint, a bigint, b bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN channel IS NULL THEN true
    WHEN channel_has(channel, a) AND channel_has(channel, b)
         AND private_channel_is_visible(channel) THEN true
    ELSE may_share_presence(a, b)
  END
$$;

CREATE OR REPLACE FUNCTION presence_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  other bots;
BEGIN
  PERFORM lock_message_pair(NEW.bot_id, NEW.other_bot_id);
  SELECT * INTO other FROM bots WHERE id = NEW.other_bot_id;
  IF other.is_house OR (SELECT is_house FROM bots WHERE id = NEW.bot_id) THEN
    RAISE EXCEPTION 'the house account has no presence' USING ERRCODE = 'UPM01';
  END IF;
  -- The lowest-id visible group the two share, whatever the writer gave.
  NEW.channel_id := (SELECT min(x) FROM shared_groups(NEW.bot_id, NEW.other_bot_id) x);
  -- Between members, the sender's own comms rules, as for a group message.
  IF NEW.channel_id IS NOT NULL AND NOT comms_takes_private(NEW.bot_id) THEN
    RAISE EXCEPTION 'bot % takes no private messages', NEW.bot_id USING ERRCODE = 'UPM01';
  END IF;
  IF NEW.channel_id IS NULL
     AND (other.frozen_at IS NOT NULL
          OR has_blocked(NEW.bot_id, NEW.other_bot_id) OR has_blocked(NEW.other_bot_id, NEW.bot_id)
          OR NOT in_conversation(NEW.bot_id, NEW.other_bot_id)
          OR (NOT are_contacts(NEW.bot_id, NEW.other_bot_id)
              AND NOT (inbox_is_open(NEW.bot_id) AND inbox_is_open(NEW.other_bot_id)))) THEN
    RAISE EXCEPTION 'bot % has no conversation with bot %', NEW.bot_id, NEW.other_bot_id USING ERRCODE = 'UPM01';
  END IF;
  IF NEW.next_check IS NOT NULL
     AND (NEW.next_check < now() - interval '5 minutes' OR NEW.next_check > now() + interval '8 days') THEN
    RAISE EXCEPTION 'next_check is out of range' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.key_id IS DISTINCT FROM (SELECT id FROM api_keys WHERE id = NEW.key_id AND bot_id = NEW.bot_id) THEN
    RAISE EXCEPTION 'presence is set with the bot''s own key';
  END IF;
  RETURN NEW;
END;
$$;

-- A recipient that blocked the setter, or is frozen, isn't woken by its
-- presence, as it isn't by a group message. Only a group member's write
-- can reach here that way.
CREATE OR REPLACE FUNCTION wake_on_presence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT has_blocked(NEW.other_bot_id, NEW.bot_id)
     AND (SELECT frozen_at IS NULL FROM bots WHERE id = NEW.other_bot_id) THEN
    PERFORM bump_wake(NEW.other_bot_id);
  END IF;
  RETURN NULL;
END;
$$;
