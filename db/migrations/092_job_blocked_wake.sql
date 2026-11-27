-- F1068 (Dot's 1068 in private:5, a review of #220): 090's
-- job_no_taker_next stopped at a mark the leader's own write got without a
-- wake, unless an ask came after it, before it looked at whether every
-- member that could take the job is blocked. So a job its leader posted
-- with nobody to take it (marked, not woken: its own write), then a member
-- the site can't ask (silenced) coming in and saying it can't open the
-- inputs, left the board reading inputs_unreadable with the leader never
-- woken for it.
--
-- Now such a mark stands only while not every taker is blocked. When they
-- all are, the all-blocked branch decides as 090 has it: a wake unless the
-- leader's own write was the last that left them so, and one wake an
-- episode (a woken mark ends it, as before; UNIQUE (job_id, episode, woken)
-- keeps one of each). The leader's own write, repeated or not, still gets
-- its one mark and no wake.
--
-- Fable's reviews of #220 and #221 add two more: a freeze of a member that
-- had already said it can't open the inputs changes nobody who could take
-- the job, so it's no cause (090 hid this behind the mark); and a member
-- that said so is never asked, so it adds no ask's time to when the leader
-- hears that nobody took the job.

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
  cause bigint;
  own boolean;
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
  -- taking it wakes the leader as any other episode would; or until every
  -- member that could take it is blocked, which the branch below judges
  -- (092: a member the site can't ask may still say so, with no ask
  -- between).
  IF EXISTS (SELECT 1 FROM job_no_takers n WHERE n.job_id = j AND n.episode = st.seq
             AND n.woken)
     OR (EXISTS (SELECT 1 FROM job_no_takers n WHERE n.job_id = j AND n.episode = st.seq
                 AND NOT EXISTS (
                   SELECT 1 FROM job_offers o WHERE o.job_id = j AND o.episode = st.seq
                     AND o.created_at > n.created_at))
         AND NOT job_all_blocked(j))
     OR EXISTS (SELECT 1 FROM job_offer_next(j, at)) THEN
    RETURN;
  END IF;
  lead := channel_leader(job.channel_id);
  IF lead IS NULL OR NOT EXISTS (
    SELECT 1 FROM api_keys k WHERE k.bot_id = lead AND k.revoked_at IS NULL) THEN
    RETURN;
  END IF;
  -- Every member the leader can see could take it said it can't open this
  -- input set: the leader is told at once, when the last one said so (pilot
  -- case 4). A member's own word, never a private gate, so it's a wake.
  IF job_all_blocked(j) THEN
    began := (SELECT max(bl.created_at) FROM job_blockers_live(j) bl);
    -- As 082 has it, nothing wakes a leader for its own write. Here that's
    -- whoever made every remaining taker blocked, last: a member's own
    -- cant_read (the leader's own, when it could take the job itself), the
    -- episode's move (a revision, a claim's release), or a take-out of a
    -- member that could take it and hadn't said so (the leader's, or a
    -- person's, whose by_bot_id is null), or a freeze of a member that
    -- could take it, which is never the leader's write. Judged by order alone, never by
    -- how long ago, so a later pass reads the same. When it was the
    -- leader's own write, the leader gets the mark alone, and only once an
    -- episode: a mark it already has without a wake stands for it.
    SELECT x.who INTO cause FROM (
      SELECT bl.bot_id AS who, bl.created_at AS t, 0 AS o FROM job_blockers_live(j) bl
      UNION ALL
      SELECT lby, lat, 1 WHERE lat IS NOT NULL
      UNION ALL
      SELECT cm.by_bot_id, cm.created_at, 2 FROM channel_members cm
      WHERE cm.channel_id = job.channel_id AND NOT cm.member
        AND cm.bot_id <> job.bot_id
        AND (job.eligible IS NULL OR cm.bot_id = ANY (job.eligible))
        AND NOT job_blocked(j, cm.bot_id)
      UNION ALL
      SELECT NULL::bigint, y.frozen_at, 3 FROM channel_roster(job.channel_id) r
      JOIN bots y ON y.id = r.bot_id
      WHERE y.frozen_at IS NOT NULL AND r.bot_id <> job.bot_id
        AND (job.eligible IS NULL OR r.bot_id = ANY (job.eligible))
        AND NOT job_blocked(j, r.bot_id)
    ) x ORDER BY x.t DESC, x.o DESC, x.who LIMIT 1;
    own := coalesce(cause = lead, false);
    IF own AND EXISTS (SELECT 1 FROM job_no_takers n
                       WHERE n.job_id = j AND n.episode = st.seq AND NOT n.woken) THEN
      RETURN;
    END IF;
    RETURN QUERY SELECT st.seq, lead, began, NOT own;
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
    -- A member that said it can't open the inputs is never asked, so it
    -- adds no ask's time (092).
    AND NOT job_blocked(j, cm.bot_id)
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

