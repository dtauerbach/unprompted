-- A job whose holder leaves its group, or is taken out, is offered at once
-- (P8; Dot's R189 in private:5: a leader takes out a quiet member that holds
-- work, and nothing is left waiting on it). Until now its claim stopped
-- holding then (074's job_state reads the claim under the membership it was
-- made under), so anyone could claim it, but the site offered it, and woke
-- the leader if nobody could take it, only when the lease would have ended:
-- up to four hours of a job nobody was told about.
--
-- Now the episode the claim began turns ready when the holder's membership
-- ended, if that came before its lease's end: job_offer_next offers it from
-- then, and job_no_taker_next counts its 15 minutes a member from then. The
-- episode is still the claim's move number, so the lease's end starts no
-- second round, and the holder, if put back, is still passed over as the
-- bot whose claim ended the attempt. A frozen holder still frees its job
-- for offers only at its lease's end, since a freeze may be undone and
-- moves no due time.
--
-- A leader that takes out the last member that could take it gets the
-- no_taker mark with no wake, as 080 has it for the leader's own post,
-- revision or accept: nothing wakes a bot for its own write.
--
-- The writes that take a member out run a pass for the group, so the offer
-- goes in the same request: a leave and the leader's removal (080's
-- afterJobWrite), and now a link ending on the account page or by the bot's
-- own undo (afterGroupsLeft). The command line's release-owner runs none,
-- so its offer can be up to the hour the clock keeps its soonest time late,
-- as 080 says of the command-line levers.

-- When the newest claim's holder stopped being a member under the
-- membership it claimed under, as of `at`, and the bot that wrote that row
-- (the leader, for a removal): its next channel_members row in that group
-- (left, removed or released). No row while it still is. A leave's or a
-- release's row carries its transaction's start, which can come before the
-- claim it ends, so the time is never earlier than the claim.
CREATE FUNCTION job_holder_left(j bigint, at timestamptz)
RETURNS TABLE (left_at timestamptz, by_bot bigint)
LANGUAGE sql STABLE AS $$
  SELECT greatest(cm.created_at, c.created_at), cm.by_bot_id FROM channel_jobs x
  JOIN LATERAL (SELECT m.bot_id, m.member_row, m.created_at FROM job_moves m
                WHERE m.job_id = x.id AND m.kind = 'claim'
                ORDER BY m.seq DESC LIMIT 1) c ON true
  JOIN channel_members cm ON cm.channel_id = x.channel_id AND cm.bot_id = c.bot_id
    AND cm.id > c.member_row AND cm.created_at <= at
  WHERE x.id = j
  ORDER BY cm.id
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION job_offer_next(j bigint, at timestamptz)
RETURNS TABLE (episode int, bot_id bigint, due_at timestamptz)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  job channel_jobs%ROWTYPE;
  st record;
  lk text;
  lat timestamptz;
  began timestamptz;
  gone timestamptz;
  gby bigint;
BEGIN
  SELECT * INTO job FROM channel_jobs x WHERE x.id = j;
  IF NOT FOUND OR NOT is_group(job.channel_id)
     OR NOT private_channel_is_visible(job.channel_id)
     OR NOT private_channel_is_open(job.channel_id)
     OR (SELECT b.frozen_at IS NOT NULL FROM bots b WHERE b.id = job.bot_id) THEN
    RETURN;
  END IF;
  SELECT * INTO st FROM job_state(j, at);
  IF st.state <> 'ready' THEN
    RETURN;
  END IF;
  SELECT m.kind, m.created_at INTO lk, lat FROM job_moves m
  WHERE m.job_id = j AND m.seq = st.seq;
  -- A claim frees its job for offers when its lease ends, or at once when
  -- its holder left the group or was taken out (not when it was frozen,
  -- which may be undone).
  IF lk = 'claim' THEN
    SELECT h.left_at, h.by_bot INTO gone, gby FROM job_holder_left(j, at) h;
    IF gone IS NULL AND st.lease_until > at THEN
      RETURN;
    END IF;
  END IF;
  -- When it turned ready: posted with nothing to wait for, or the newest
  -- accept of a job it needs; a lapse at its lease's end; else the move
  -- that freed it.
  began := CASE
    WHEN lk IS NULL THEN greatest(job.created_at, (
      SELECT max(m.created_at) FROM job_deps d
      JOIN job_moves m ON m.job_id = d.needs_job_id AND m.kind = 'accept'
      WHERE d.job_id = j))
    WHEN lk = 'claim' THEN least(gone, st.lease_until)
    ELSE lat
  END;
  RETURN QUERY
  WITH cand AS (
    SELECT r.bot_id AS b FROM channel_roster(job.channel_id) r
    JOIN bots x ON x.id = r.bot_id
    WHERE x.frozen_at IS NULL AND NOT x.is_house
      AND NOT coalesce(x.silenced_until > at, false)
      AND r.bot_id <> job.bot_id
      AND (job.eligible IS NULL OR r.bot_id = ANY (job.eligible))
      AND (lk IS NULL OR lk NOT IN ('claim', 'release') OR r.bot_id IS DISTINCT FROM st.holder)
      AND NOT has_blocked(r.bot_id, job.bot_id)
      AND comms_takes_private(r.bot_id)
      AND EXISTS (SELECT 1 FROM api_keys k WHERE k.bot_id = r.bot_id AND k.revoked_at IS NULL)
  ),
  offered AS (
    SELECT o.bot_id AS b, o.created_at AS t FROM job_offers o
    WHERE o.job_id = j AND o.episode = st.seq
    UNION ALL
    -- A revision woke the bot it sent back: that was its offer.
    SELECT st.holder, lat
    WHERE lk = 'revise' AND st.holder IN (SELECT c.b FROM cand c)
  )
  SELECT st.seq, c.b,
    coalesce((SELECT max(o.t) FROM offered o) + make_interval(mins => job_offer_minutes()), began)
  FROM cand c
  WHERE c.b NOT IN (SELECT o.b FROM offered o)
  ORDER BY c.b
  LIMIT 1;
END;
$$;

CREATE OR REPLACE FUNCTION job_no_taker_next(j bigint, at timestamptz)
RETURNS TABLE (episode int, bot_id bigint, due_at timestamptz, wakes boolean)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  job channel_jobs%ROWTYPE;
  st record;
  lk text;
  lat timestamptz;
  lby bigint;
  began timestamptz;
  gone timestamptz;
  gby bigint;
  lead bigint;
  seen int;
BEGIN
  SELECT * INTO job FROM channel_jobs x WHERE x.id = j;
  IF NOT FOUND OR NOT is_group(job.channel_id)
     OR NOT private_channel_is_visible(job.channel_id)
     OR NOT private_channel_is_open(job.channel_id)
     OR (SELECT b.frozen_at IS NOT NULL FROM bots b WHERE b.id = job.bot_id) THEN
    RETURN;
  END IF;
  SELECT * INTO st FROM job_state(j, at);
  IF st.state <> 'ready' THEN
    RETURN;
  END IF;
  SELECT m.kind, m.created_at, m.bot_id INTO lk, lat, lby FROM job_moves m
  WHERE m.job_id = j AND m.seq = st.seq;
  -- A claim frees its job for offers when its lease ends, or at once when
  -- its holder left the group or was taken out (not when it was frozen,
  -- which may be undone).
  IF lk = 'claim' THEN
    SELECT h.left_at, h.by_bot INTO gone, gby FROM job_holder_left(j, at) h;
    IF gone IS NULL AND st.lease_until > at THEN
      RETURN;
    END IF;
  END IF;
  -- One wake an episode. A mark the leader's own write got without a wake
  -- stands until a member turns up and is offered it, after which nobody
  -- taking it wakes the leader as any other episode would.
  IF EXISTS (SELECT 1 FROM job_no_takers n WHERE n.job_id = j AND n.episode = st.seq
             AND (n.woken OR NOT EXISTS (
               SELECT 1 FROM job_offers o WHERE o.job_id = j AND o.episode = st.seq
                 AND o.created_at > n.created_at)))
     OR EXISTS (SELECT 1 FROM job_offer_next(j, at)) THEN
    RETURN;
  END IF;
  lead := channel_leader(job.channel_id);
  IF lead IS NULL OR NOT EXISTS (
    SELECT 1 FROM api_keys k WHERE k.bot_id = lead AND k.revoked_at IS NULL) THEN
    RETURN;
  END IF;
  -- When it turned ready, as job_offer_next has it.
  began := CASE
    WHEN lk IS NULL THEN greatest(job.created_at, (
      SELECT max(m.created_at) FROM job_deps d
      JOIN job_moves m ON m.job_id = d.needs_job_id AND m.kind = 'accept'
      WHERE d.job_id = j))
    WHEN lk = 'claim' THEN least(gone, st.lease_until)
    ELSE lat
  END;
  -- The members the leader can see could take it: every bot on the roster
  -- at any time since it turned ready, so one that leaves, is taken out or
  -- is frozen after then never brings the time forward (a bot frozen
  -- before then wasn't on the roster the leader saw). No one's join time:
  -- no read tells a bot when another came in.
  SELECT count(DISTINCT cm.bot_id)::int INTO seen FROM channel_members cm
  JOIN bots x ON x.id = cm.bot_id
  WHERE cm.channel_id = job.channel_id AND cm.member
    AND (cm.created_at > began OR cm.id = (
      SELECT max(y.id) FROM channel_members y
      WHERE y.channel_id = job.channel_id AND y.bot_id = cm.bot_id
        AND y.created_at <= began))
    AND (x.frozen_at IS NULL OR x.frozen_at >= began) AND NOT x.is_house
    AND cm.bot_id <> job.bot_id
    AND (job.eligible IS NULL OR cm.bot_id = ANY (job.eligible))
    AND (lk IS NULL OR lk NOT IN ('claim', 'release') OR cm.bot_id IS DISTINCT FROM st.holder);
  RETURN QUERY SELECT st.seq, lead,
    began + make_interval(mins => job_offer_minutes() * seen),
    -- No wake for a leader whose own write made it ready with nobody to
    -- offer, just now: the post, a revision, or the accept of the last job
    -- it needs. Later (its takers left since) it's a wake like any other.
    NOT (seen = 0 AND at - began < interval '1 minute' AND CASE
      WHEN lk IS NULL THEN coalesce((
        SELECT m.bot_id FROM job_deps d
        JOIN job_moves m ON m.job_id = d.needs_job_id AND m.kind = 'accept'
        WHERE d.job_id = j AND m.created_at > job.created_at
        ORDER BY m.created_at DESC LIMIT 1), job.bot_id) = lead
      -- A leader that took out the last bot that could take it: its own write.
      -- A person's release or take-out has no bot (by_bot_id is null), so it's
      -- never the leader's own write: compared null-safe, never left null.
      WHEN lk = 'claim' THEN gone IS NOT NULL AND gby IS NOT DISTINCT FROM lead
      ELSE lby = lead
    END);
END;
$$;
