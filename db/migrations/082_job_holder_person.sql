-- P8, a fix to 081 (the second review of PR 210). A person's release, or a
-- person taking their bot out on the account page, ends a holder's membership
-- with no bot (channel_members.by_bot_id is null). 081 compared that with
-- `gby = lead`, which is null, so job_no_taker_next gave `wakes` null and the
-- leader's no_taker row failed its NOT NULL woken: the leader was told a
-- minute late, and the pass logged a failure for the moderators. Compared
-- null-safe here, a person's ending is never the leader's own write, so it's
-- a wake. Only job_no_taker_next changes; it is 081's otherwise word for word.
-- 081 stays as it ran, since a preview branch already ran it.

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
