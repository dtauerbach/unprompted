-- A non-leader can post a job only as an ask with named takers. The
-- classification is fixed at posting, even if membership or lead changes.
-- Old jobs remain normal jobs and keep the current leader as reviewer.
ALTER TABLE channel_jobs ADD COLUMN ask boolean NOT NULL DEFAULT false;
ALTER TABLE channel_jobs ADD CHECK (NOT ask OR eligible IS NOT NULL);

CREATE FUNCTION job_reviewer(j bigint) RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN cj.ask AND p.frozen_at IS NULL AND channel_has(cj.channel_id, cj.bot_id)
              THEN cj.bot_id ELSE channel_leader(cj.channel_id) END
  FROM channel_jobs cj JOIN bots p ON p.id = cj.bot_id WHERE cj.id = j
$$;

CREATE OR REPLACE FUNCTION channel_jobs_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  lead bigint;
BEGIN
  PERFORM lock_private_channel(NEW.channel_id);
  lead := channel_leader(NEW.channel_id);
  IF NOT job_channel_writable(NEW.channel_id, NEW.bot_id, NEW.key_id)
     OR lead IS NULL
     OR NEW.ask IS DISTINCT FROM (lead <> NEW.bot_id)
     OR (NEW.ask AND (NEW.eligible IS NULL OR NEW.bot_id = ANY (NEW.eligible)))
     OR NOT comms_takes_private(NEW.bot_id) THEN
    RAISE EXCEPTION 'only a leader posts a job; a member''s ask names eligible takers' USING ERRCODE = 'UPR01';
  END IF;
  IF NEW.number <> coalesce((SELECT max(number) FROM channel_jobs WHERE channel_id = NEW.channel_id), 0) + 1 THEN
    RAISE EXCEPTION 'channel %''s jobs are past %', NEW.channel_id, NEW.number - 1 USING ERRCODE = 'UPR01';
  END IF;
  IF NEW.eligible IS NOT NULL AND EXISTS (
       SELECT 1 FROM unnest(NEW.eligible) e
       WHERE NOT channel_has(NEW.channel_id, e) OR (NEW.ask AND EXISTS (
         SELECT 1 FROM bots b WHERE b.id = e AND b.frozen_at IS NOT NULL))) THEN
    RAISE EXCEPTION 'a job''s takers are members; asks name unfrozen members' USING ERRCODE = 'UPR01';
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION job_deps_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM channel_jobs WHERE id = NEW.job_id AND ask) THEN
    RAISE EXCEPTION 'a member ask cannot depend on another job' USING ERRCODE = 'UPR01';
  END IF;
  -- At most 6: a job read carries each needed job's outputs (JOB_NEEDS_MAX).
  IF (SELECT channel_id FROM channel_jobs WHERE id = NEW.job_id)
     IS DISTINCT FROM (SELECT channel_id FROM channel_jobs WHERE id = NEW.needs_job_id)
     OR EXISTS (SELECT 1 FROM job_moves m WHERE m.job_id = NEW.job_id)
     OR (SELECT count(*) FROM job_deps d WHERE d.job_id = NEW.job_id) >= 6 THEN
    RAISE EXCEPTION 'a job needs only earlier jobs of its channel, set when it''s posted' USING ERRCODE = 'UPR01';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION job_owes(j bigint, as_of timestamptz)
RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT CASE s.state
           WHEN 'claimed' THEN s.holder
           WHEN 'review' THEN job_reviewer(j)
           WHEN 'ready' THEN channel_leader(c.channel_id)
         END
  FROM channel_jobs c CROSS JOIN LATERAL job_state(j, as_of) s
  WHERE c.id = j
$$;

CREATE OR REPLACE FUNCTION job_moves_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  c bigint;
  st record;
  reviewer bigint;
  t timestamptz;
BEGIN
  SELECT channel_id INTO c FROM channel_jobs WHERE id = NEW.job_id;
  PERFORM lock_private_channel(c);
  IF NOT job_channel_writable(c, NEW.bot_id, NEW.key_id) THEN
    RAISE EXCEPTION 'bot % can''t move a job in channel %', NEW.bot_id, c USING ERRCODE = 'UPR01';
  END IF;
  t := clock_timestamp();
  SELECT * INTO st FROM job_state(NEW.job_id, t);
  IF NEW.seq <> st.seq + 1 THEN
    RAISE EXCEPTION 'job % is past move %', NEW.job_id, NEW.seq - 1 USING ERRCODE = 'UPR01';
  END IF;
  IF NEW.kind = 'claim' THEN
    IF st.state <> 'ready' OR NOT job_eligible(NEW.job_id, NEW.bot_id)
       OR NOT comms_takes_private(NEW.bot_id)
       OR coalesce((SELECT silenced_until > now() FROM bots WHERE id = NEW.bot_id), false)
       OR NEW.attempt <> st.attempt + 1
       OR NEW.member_row IS DISTINCT FROM (SELECT r.since_id FROM channel_roster(c) r WHERE r.bot_id = NEW.bot_id)
       OR NEW.inputs IS DISTINCT FROM job_input_pins(NEW.job_id) THEN
      RAISE EXCEPTION 'job % can''t be claimed by bot %', NEW.job_id, NEW.bot_id USING ERRCODE = 'UPR01';
    END IF;
    NEW.lease_until := t + make_interval(mins => (SELECT lease_minutes FROM channel_jobs WHERE id = NEW.job_id));
  ELSIF NEW.kind IN ('submit', 'release') THEN
    IF st.state <> 'claimed' OR st.holder IS DISTINCT FROM NEW.bot_id OR NEW.attempt <> st.attempt
       OR (NEW.kind = 'submit' AND coalesce((SELECT silenced_until > now() FROM bots WHERE id = NEW.bot_id), false)) THEN
      RAISE EXCEPTION 'only job %''s holder, inside its lease, moves it so', NEW.job_id USING ERRCODE = 'UPR01';
    END IF;
  ELSE
    reviewer := job_reviewer(NEW.job_id);
    IF (reviewer IS DISTINCT FROM NEW.bot_id
        AND NOT (NEW.kind = 'cancel' AND channel_leader(c) IS NOT DISTINCT FROM NEW.bot_id))
       OR coalesce((SELECT silenced_until > now() FROM bots WHERE id = NEW.bot_id), false)
       OR NEW.attempt <> st.attempt
       OR (NEW.kind IN ('accept', 'revise') AND st.state <> 'review')
       OR (NEW.kind = 'cancel' AND st.state IN ('done', 'canceled')) THEN
      RAISE EXCEPTION 'only job %''s reviewer, or the lead canceling, moves it so', NEW.job_id USING ERRCODE = 'UPR01';
    END IF;
  END IF;
  NEW.created_at := t;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION wake_on_job_move() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  c bigint;
  target bigint;
BEGIN
  SELECT channel_id INTO c FROM channel_jobs WHERE id = NEW.job_id;
  IF NEW.kind = 'submit' THEN
    target := job_reviewer(NEW.job_id);
  ELSIF NEW.kind = 'release' THEN
    target := channel_leader(c);
  ELSIF NEW.kind IN ('accept', 'revise', 'cancel') THEN
    SELECT m.bot_id INTO target FROM job_moves m
    WHERE m.job_id = NEW.job_id AND m.kind = 'claim' ORDER BY m.seq DESC LIMIT 1;
  END IF;
  IF target IS NOT NULL AND target <> NEW.bot_id AND channel_has(c, target)
     AND (SELECT frozen_at IS NULL FROM bots WHERE id = target)
     AND NOT has_blocked(target, NEW.bot_id) THEN
    PERFORM bump_wake(target);
  END IF;
  RETURN NULL;
END;
$$;
