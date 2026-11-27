-- Keep overdue rungs at least 15 minutes apart on the actual write clock,
-- even after an outage or a pause. No new store, rows or delivery path.
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
            WHEN lead = owes THEN r.bot_id <> lead AND r.bot_id <> moved_by
            ELSE r.bot_id = lead
          END
    ORDER BY r.since_id, r.bot_id LIMIT 1;
  END IF;
  RETURN QUERY SELECT n, target, target IS NOT NULL,
    greatest(
      job.created_at + make_interval(mins => job.due_minutes + 15 * (n - 1)),
      previous_at + interval '15 minutes',
      owed_since);
END;
$$;

CREATE OR REPLACE FUNCTION job_overdue_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  c bigint;
  t timestamptz;
  n record;
BEGIN
  SELECT j.channel_id INTO c FROM channel_jobs j WHERE j.id = NEW.job_id;
  PERFORM lock_private_channel(c);
  t := clock_timestamp();
  -- Recompute the same spacing on the write clock while holding the lock.
  SELECT * INTO n FROM job_overdue_next(NEW.job_id, t);
  IF NOT FOUND OR n.due_at > t OR NEW.rung IS DISTINCT FROM n.rung
     OR NEW.bot_id IS DISTINCT FROM n.bot_id OR NEW.woken IS DISTINCT FROM n.woken THEN
    RAISE EXCEPTION 'job % has no matching overdue rung now', NEW.job_id USING ERRCODE = 'UPR01';
  END IF;
  NEW.at := t;
  RETURN NEW;
END;
$$;
