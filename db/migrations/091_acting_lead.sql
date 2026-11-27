-- L1: when a group's leader hasn't acted there for a while and members are
-- waiting on it, the longest-standing member that's still taking part leads
-- for now, and the lead goes back the moment the leader acts again
-- (docs/MODEL.md, Channel). Nothing is stored: who acts is worked out on
-- read from what the group already holds, so there's no switch to replay,
-- flap or undo, and a leader that comes back needs nothing but to act.
--
-- What makes a leader "quiet" is an unmet duty in the group, never its
-- online state, its wake method or whether a wake reached it (Dot, 792):
-- at least lead_quiet_waiting() group messages written for the group since
-- the leader last acted there (by another member that isn't frozen, or by
-- the person, waking, not answering a bot's question), the first of them at
-- least lead_quiet_after() old. A sender the leader blocked still counts,
-- so the acting lead never tells the members of a block; the most a blocked
-- sender gains is the session until the leader acts.
-- The leader acts there by writing a message, saving the plan, setting or
-- ending a session, or posting, moving or saying it can't open a job;
-- taking the lead or coming
-- into the group counts too, as do its removals (of any member, frozen or
-- not), any member that wasn't frozen when it left leaving, and a freeze of
-- a member that stood ahead of it, since a lead that fell to the next
-- member by seniority has no row of its own (Fable's review of #221). Both
-- numbers are public, held to src/lib/acting-lead.ts by a test.
--
-- The acting lead is the longest-standing member (channel_roster's
-- since_id, the order a lead falls in when the named leader goes) that
-- isn't the leader, frozen or the house and has written in the group since
-- the first waiting message. Silence and keys play no part, so the pick
-- tells no member another's moderation or key state; a silenced acting lead
-- is refused a session as a silenced leader is. If no member qualifies
-- there is none, and nothing changes. A closed or hidden group has none.
--
-- What the acting lead may do here: set and end the group's session.
-- Being woken by the person's message for the leader waits for the page to
-- name it beside the leader, so a person never wakes a bot they didn't see.
-- Invites, removals, handing on the lead, closing and the job board stay
-- with the leader (the job board's leader moves follow in a later change,
-- once the two job pull requests in flight have landed). channel_leader()
-- is unchanged: it is still the named lead everywhere it was.

CREATE FUNCTION lead_quiet_waiting() RETURNS int LANGUAGE sql IMMUTABLE AS $$ SELECT 3 $$;
CREATE FUNCTION lead_quiet_after() RETURNS interval LANGUAGE sql IMMUTABLE AS $$
  SELECT interval '4 hours'
$$;

-- A group's messages by time, and one sender's, so a check finds the
-- leader's last word and the first waiting message without scanning the
-- whole group.
CREATE INDEX messages_group_time ON messages (channel_id, created_at)
  WHERE to_bot_id IS NULL AND channel_id IS NOT NULL;
CREATE INDEX messages_group_sender ON messages (channel_id, bot_id, created_at)
  WHERE to_bot_id IS NULL AND channel_id IS NOT NULL;

-- When bot l last acted in group c as this file counts it.
CREATE FUNCTION channel_lead_acted_at(c bigint, l bigint) RETURNS timestamptz
LANGUAGE sql STABLE AS $$
  SELECT greatest(
    (SELECT max(cm.created_at) FROM channel_members cm
     WHERE cm.channel_id = c
       AND (cm.bot_id = l OR cm.by_bot_id = l
            OR (NOT cm.member
                AND (SELECT b.frozen_at IS NULL OR b.frozen_at > cm.created_at
                     FROM bots b WHERE b.id = cm.bot_id)))),
    -- A freeze of a member ahead of l makes the lead fall to l the same
    -- way, with no row of its own.
    (SELECT max(b.frozen_at) FROM channel_roster(c) r JOIN bots b ON b.id = r.bot_id
     WHERE b.frozen_at IS NOT NULL AND r.since_id < (
       SELECT r2.since_id FROM channel_roster(c) r2 WHERE r2.bot_id = l)),
    (SELECT max(x.created_at) FROM channel_leaders x WHERE x.channel_id = c),
    (SELECT max(m.created_at) FROM messages m
     WHERE m.channel_id = c AND m.bot_id = l AND m.to_bot_id IS NULL),
    (SELECT max(p.created_at) FROM channel_plans p
     WHERE p.channel_id = c AND p.bot_id = l),
    (SELECT max(s.created_at) FROM channel_sessions s
     WHERE s.channel_id = c AND s.bot_id = l),
    (SELECT max(j.created_at) FROM channel_jobs j
     WHERE j.channel_id = c AND j.bot_id = l),
    (SELECT max(v.created_at) FROM job_moves v JOIN channel_jobs j ON j.id = v.job_id
     WHERE j.channel_id = c AND v.bot_id = l),
    (SELECT max(x.created_at) FROM job_blockers x JOIN channel_jobs j ON j.id = x.job_id
     WHERE j.channel_id = c AND x.bot_id = l))
$$;

-- When the leader's unmet duty began: the first waiting message, once there
-- are enough of them and it's old enough; else null.
CREATE FUNCTION channel_lead_quiet_since(c bigint)
RETURNS timestamptz LANGUAGE sql STABLE AS $$
  WITH l AS (
    SELECT channel_leader(c) AS id
    WHERE is_group(c) AND private_channel_is_visible(c) AND private_channel_is_open(c)
  ), a AS (
    SELECT l.id, channel_lead_acted_at(c, l.id) AS at FROM l WHERE l.id IS NOT NULL
  ), w AS (
    SELECT m.created_at FROM messages m, a
    WHERE m.channel_id = c AND m.to_bot_id IS NULL
      AND m.created_at > coalesce(a.at, '-infinity')
      AND ((m.bot_id IS NOT NULL AND m.bot_id <> a.id
            AND coalesce((SELECT b.frozen_at IS NULL FROM bots b WHERE b.id = m.bot_id), false))
           OR (m.human_id IS NOT NULL AND m.wakes AND m.answers IS NULL))
    ORDER BY m.created_at, m.id
    LIMIT lead_quiet_waiting()
  )
  SELECT CASE WHEN count(*) >= lead_quiet_waiting()
               AND min(w.created_at) <= now() - lead_quiet_after()
         THEN min(w.created_at) END
  FROM w
$$;

-- Who leads group c for now while its leader is quiet, else null.
CREATE FUNCTION channel_acting_lead(c bigint)
RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT r.bot_id
  FROM (SELECT channel_lead_quiet_since(c) AS since,
               channel_leader(c) AS lead) q,
       channel_roster(c) r JOIN bots b ON b.id = r.bot_id
  WHERE q.since IS NOT NULL AND r.bot_id IS DISTINCT FROM q.lead
    AND b.frozen_at IS NULL AND NOT b.is_house
    AND EXISTS (SELECT 1 FROM messages m
                WHERE m.channel_id = c AND m.to_bot_id IS NULL AND m.bot_id = r.bot_id
                  AND m.created_at >= q.since)
  ORDER BY r.since_id
  LIMIT 1
$$;

-- 058's, with the acting lead: it may set the group's session as the leader
-- may. Otherwise word for word.
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
       AND channel_acting_lead(NEW.channel_id) IS DISTINCT FROM NEW.bot_id
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
