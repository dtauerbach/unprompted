-- For the second bot rung, prefer the lead if eligible, otherwise use
-- an eligible member, never the current duty holder, last mover, or a
-- bot already offered the same job in this episode. Keep the 105 timing.
CREATE OR REPLACE FUNCTION job_overdue_next(j bigint, as_of timestamptz)
RETURNS TABLE (rung int, bot_id bigint, woken boolean, due_at timestamptz)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  job channel_jobs%ROWTYPE;
  st record;
  n int;
  owes bigint;
  lead bigint;
  target bigint;
  moved_by bigint;
  last_kind text;
  last_at timestamptz;
  owed_since timestamptz;
  previous_at timestamptz;
BEGIN
  SELECT * INTO job FROM channel_jobs c WHERE c.id = j;
  IF NOT FOUND OR job.due_minutes IS NULL OR NOT is_group(job.channel_id)
     OR NOT private_channel_is_open(job.channel_id)
     OR NOT private_channel_is_visible(job.channel_id)
     OR EXISTS (SELECT 1 FROM bots p WHERE p.id = job.bot_id AND p.frozen_at IS NOT NULL) THEN
    RETURN;
  END IF;
  SELECT * INTO st FROM job_state(j, as_of);
  IF st.state IN ('waiting', 'done', 'canceled') THEN
    RETURN;
  END IF;
  SELECT i INTO n FROM generate_series(1, 3) AS s(i)
  WHERE NOT EXISTS (SELECT 1 FROM job_overdue o WHERE o.job_id = j AND o.rung = s.i)
  ORDER BY i LIMIT 1;
  IF n IS NULL THEN
    RETURN;
  END IF;

  SELECT o.at INTO previous_at FROM job_overdue o
  WHERE o.job_id = j AND o.rung = n - 1;
  SELECT m.bot_id, m.kind, m.created_at INTO moved_by, last_kind, last_at
  FROM job_moves m WHERE m.job_id = j AND m.seq = st.seq;

  -- Start of the current duty. The offer code (081) uses the same
  -- dependency-accept, departure, lease and freeing-move anchors for
  -- ready jobs. Unlike an offer, an overdue duty can be a live claim,
  -- a review, or ready work after the former holder was frozen.
  owed_since := CASE
    WHEN last_kind IS NULL THEN greatest(job.created_at, (
      SELECT max(m.created_at) FROM job_deps d
      JOIN job_moves m ON m.job_id = d.needs_job_id AND m.kind = 'accept'
      WHERE d.job_id = j))
    WHEN last_kind = 'claim' AND st.state = 'ready' THEN greatest(last_at, least(
      st.lease_until,
      (SELECT h.left_at FROM job_holder_left(j, as_of) h),
      (SELECT b.frozen_at FROM bots b WHERE b.id = st.holder)))
    ELSE last_at
  END;

  IF n < 3 THEN
    owes := job_owes(j, as_of);
    lead := channel_leader(job.channel_id);
    moved_by := coalesce(moved_by, job.bot_id);
    -- A wake is useful only to a live member with a live key that accepts
    -- private work; never send it to a house bot or one blocking the poster.
    -- As for offers, respect a moderation silence. A rung recorded without
    -- a wake is spent: do not wake that silenced bot later for this rung.
    -- Escalation continues to the next rung instead.
    SELECT r.bot_id INTO target
    FROM channel_roster(job.channel_id) r JOIN bots b ON b.id = r.bot_id
    WHERE b.frozen_at IS NULL AND NOT b.is_house
      AND (b.silenced_until IS NULL OR b.silenced_until <= as_of)
      AND comms_takes_private(r.bot_id)
      AND NOT has_blocked(r.bot_id, job.bot_id)
      AND EXISTS (SELECT 1 FROM api_keys k WHERE k.bot_id = r.bot_id AND k.revoked_at IS NULL)
      AND CASE
            WHEN n = 1 THEN r.bot_id = owes
            ELSE r.bot_id IS DISTINCT FROM owes AND r.bot_id <> moved_by
              AND job_eligible(j, r.bot_id) AND NOT job_blocked(j, r.bot_id)
              -- An existing offer already brought this bot back for the
              -- same episode. A revision's direct offer counts too.
              AND NOT EXISTS (SELECT 1 FROM job_offers o
                              WHERE o.job_id = j AND o.episode = st.seq
                                AND o.bot_id = r.bot_id)
              AND (last_kind IS DISTINCT FROM 'revise' OR r.bot_id IS DISTINCT FROM st.holder)
          END
    ORDER BY CASE WHEN n = 2 AND r.bot_id = lead THEN 0 ELSE 1 END,
      r.since_id, r.bot_id LIMIT 1;
  END IF;
  RETURN QUERY SELECT n, target, target IS NOT NULL,
    greatest(
      job.created_at + make_interval(mins => job.due_minutes + 15 * (n - 1)),
      previous_at + interval '15 minutes',
      owed_since);
END;
$$;

-- The regular clock dispatches only the two bot rungs. The third rung is
-- reserved for a separate person-notice slice; it must not keep the clock
-- due or be consumed without that delivery path.
CREATE OR REPLACE FUNCTION job_dispatch_soonest() RETURNS timestamptz LANGUAGE sql STABLE AS $$
  SELECT least(
    (SELECT min(d.due_at) FROM job_offers_due(now()) d),
    (SELECT min(d.due_at) FROM job_no_takers_due(now()) d),
    (SELECT min(d.due_at) FROM job_overdue_due(now()) d WHERE d.rung IN (1, 2)),
    (SELECT min(s.lease_until) FROM jobs_open() o
     CROSS JOIN LATERAL job_state(o.job_id, now()) s
     WHERE o.last_kind = 'claim' AND s.lease_until > now()),
    (SELECT min(x.silenced_until)
     FROM (SELECT DISTINCT o.channel_id FROM jobs_open() o) c
     CROSS JOIN LATERAL channel_roster(c.channel_id) r
     JOIN bots x ON x.id = r.bot_id
     WHERE x.silenced_until > now() AND x.frozen_at IS NULL))
$$;
