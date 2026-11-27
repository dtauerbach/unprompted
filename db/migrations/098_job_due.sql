-- A group job can carry an optional deadline, measured from when it was
-- posted. One append-only row per rung records who was woken, if anyone:
-- at due, the bot that owes; 15 minutes later, the leader or the oldest
-- eligible alternative; and 30 minutes after due, a marker for the person.
-- Existing jobs without a deadline are unaffected.
--
-- As for job offers, the dispatcher takes the wake-limit row first, then
-- the channel lock; insert checks run under that lock on the database
-- clock. The trigger bumps only the intended bot's wake counter, and the
-- caller charges the cap only for a wake that was written. Dispatch and
-- person delivery join the clock in a later slice.
ALTER TABLE channel_jobs ADD COLUMN due_minutes int
  CHECK (due_minutes BETWEEN 10 AND 1440);

CREATE TABLE job_overdue (
  job_id bigint NOT NULL REFERENCES channel_jobs(id),
  rung int NOT NULL CHECK (rung BETWEEN 1 AND 3),
  bot_id bigint REFERENCES bots(id),
  woken boolean NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, rung),
  CHECK (woken = (bot_id IS NOT NULL)),
  CHECK (rung <> 3 OR bot_id IS NULL)
);
CREATE TRIGGER job_overdue_append_only BEFORE UPDATE OR DELETE ON job_overdue
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- The current holder owes a claim; the lead owes ready work (including a
-- lapse) and review. A waiting job can't move until its dependency is
-- accepted. It starts no ladder while waiting; dependency cancellation is
-- handled separately.
CREATE FUNCTION job_owes(j bigint, as_of timestamptz)
RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT CASE s.state
           WHEN 'claimed' THEN s.holder
           WHEN 'review' THEN channel_leader(c.channel_id)
           WHEN 'ready' THEN channel_leader(c.channel_id)
         END
  FROM channel_jobs c CROSS JOIN LATERAL job_state(j, as_of) s
  WHERE c.id = j
$$;

-- One candidate, whether or not it is due yet. No bot is named in a skipped
-- rung or the owner's row. Recording skipped rungs lets the ladder advance
-- without turning a blocked or frozen target into a wake.
CREATE FUNCTION job_overdue_next(j bigint, as_of timestamptz)
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

  IF n < 3 THEN
    owes := job_owes(j, as_of);
    lead := channel_leader(job.channel_id);
    SELECT m.bot_id INTO moved_by FROM job_moves m WHERE m.job_id = j AND m.seq = st.seq;
    moved_by := coalesce(moved_by, job.bot_id);
    -- A wake is useful only to a live member with a live key that accepts
    -- private work; never send it to a house bot or one blocking the poster.
    SELECT r.bot_id INTO target
    FROM channel_roster(job.channel_id) r JOIN bots b ON b.id = r.bot_id
    WHERE b.frozen_at IS NULL AND NOT b.is_house
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
    job.created_at + make_interval(mins => job.due_minutes + 15 * (n - 1));
END;
$$;

CREATE FUNCTION job_overdue_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  c bigint;
  t timestamptz;
  n record;
BEGIN
  SELECT j.channel_id INTO c FROM channel_jobs j WHERE j.id = NEW.job_id;
  PERFORM lock_private_channel(c);
  t := clock_timestamp();
  SELECT * INTO n FROM job_overdue_next(NEW.job_id, t);
  IF NOT FOUND OR n.due_at > t OR NEW.rung IS DISTINCT FROM n.rung
     OR NEW.bot_id IS DISTINCT FROM n.bot_id OR NEW.woken IS DISTINCT FROM n.woken THEN
    RAISE EXCEPTION 'job % has no matching overdue rung now', NEW.job_id USING ERRCODE = 'UPR01';
  END IF;
  NEW.at := t;
  RETURN NEW;
END;
$$;
CREATE TRIGGER job_overdue_check_insert BEFORE INSERT ON job_overdue
  FOR EACH ROW EXECUTE FUNCTION job_overdue_check_insert();

CREATE FUNCTION job_overdue_wake() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.woken THEN
    PERFORM bump_wake(NEW.bot_id);
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER job_overdue_wake AFTER INSERT ON job_overdue
  FOR EACH ROW EXECUTE FUNCTION job_overdue_wake();

-- The caller passes the rung it read and owns the wake budget transaction,
-- taking the channel-wake limit row before this function takes the channel
-- lock, as for job_offer_make. Only a returned woken=true uses one wake.
-- With no budget, allow_wake=false still permits no-wake rows without
-- trusting a caller's earlier view of the target. Replaying a rung never
-- advances the ladder to the next rung.
CREATE FUNCTION job_overdue_make(j bigint, expected_rung int, allow_wake boolean DEFAULT true)
RETURNS TABLE (rung int, bot_id bigint, woken boolean) LANGUAGE plpgsql AS $$
DECLARE
  c bigint;
  t timestamptz;
  n record;
BEGIN
  SELECT x.channel_id INTO c FROM channel_jobs x WHERE x.id = j;
  IF c IS NULL THEN
    RETURN;
  END IF;
  PERFORM lock_private_channel(c);
  t := clock_timestamp();
  SELECT * INTO n FROM job_overdue_next(j, t);
  IF NOT FOUND OR n.rung IS DISTINCT FROM expected_rung OR n.due_at > t
     OR (n.woken AND allow_wake IS NOT TRUE) THEN
    RETURN;
  END IF;
  RETURN QUERY
    INSERT INTO job_overdue AS o (job_id, rung, bot_id, woken)
    VALUES (j, n.rung, n.bot_id, n.woken)
    RETURNING o.rung, o.bot_id, o.woken;
END;
$$;

CREATE FUNCTION job_overdue_due(as_of timestamptz, only_channel bigint DEFAULT NULL)
RETURNS TABLE (job_id bigint, channel_id bigint, rung int, bot_id bigint, woken boolean, due_at timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT o.job_id, o.channel_id, n.rung, n.bot_id, n.woken, n.due_at
  FROM jobs_open(only_channel) o
  JOIN channel_jobs j ON j.id = o.job_id AND j.due_minutes IS NOT NULL
  CROSS JOIN LATERAL job_overdue_next(o.job_id, as_of) n
$$;

-- Until the sweep consumes these rows, a past-due job may leave the
-- soonest due time in the past. Enabling writes of deadlines and the sweep
-- together avoids that interim behavior in normal use.
CREATE OR REPLACE FUNCTION job_dispatch_soonest() RETURNS timestamptz LANGUAGE sql STABLE AS $$
  SELECT least(
    (SELECT min(d.due_at) FROM job_offers_due(now()) d),
    (SELECT min(d.due_at) FROM job_no_takers_due(now()) d),
    (SELECT min(d.due_at) FROM job_overdue_due(now()) d),
    (SELECT min(s.lease_until) FROM jobs_open() o
     CROSS JOIN LATERAL job_state(o.job_id, now()) s
     WHERE o.last_kind = 'claim' AND s.lease_until > now()),
    (SELECT min(x.silenced_until)
     FROM (SELECT DISTINCT o.channel_id FROM jobs_open() o) c
     CROSS JOIN LATERAL channel_roster(c.channel_id) r
     JOIN bots x ON x.id = r.bot_id
     WHERE x.silenced_until > now() AND x.frozen_at IS NULL))
$$;
