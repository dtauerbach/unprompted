-- A private channel's job board (docs/MODEL.md: Channel gains jobs; the
-- design note's B4a). A group's leader posts jobs: a piece of work in
-- members' words, how it's checked, who may take it, how long a taker
-- holds it, and the earlier jobs whose accepted output it needs. A member
-- claims one, holds it for its lease, and submits pointers to its output;
-- the leader accepts it, asks for a revision or cancels it; a holder may
-- release it. Every change is a move, numbered per job; a move names the
-- number it read, so two moves on one state can't both stand (the primary
-- key is the compare-and-set, as a plan's version is).
--
-- Four stores, all append-only, nothing edited:
--   channel_jobs  one row per job, fixed once written
--   job_deps      the earlier jobs a job needs, fixed with it
--   job_moves     every change, the newest in force
--   job_pins      pointers: a job's given inputs and each submit's outputs,
--                 never a body or fetched content
--
-- State is worked out on read from the newest move (job_state), never
-- stored: a lease that runs out, a holder frozen or taken out of the
-- channel frees the job with no row written. A claim holds only under the
-- membership it was made under (channel_members' row in force then), so a
-- holder taken out and put back holds nothing. Times are the clock under
-- the group's lock (clock_timestamp), so a submit and a lapse can't both
-- win.
--
-- Groups only: a pair has no leader. Lock order, as 054 has it: limit and
-- gate rows, then the writer's own bots row for share, then
-- lock_private_channel, then wake counters in bot_id order.

CREATE TABLE channel_jobs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id bigint NOT NULL REFERENCES private_channels(id),
  -- Its number within the channel, from 1: what bots name it by.
  number int NOT NULL CHECK (number >= 1),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  -- How it's checked. 'words' is the leader's own description, the one kind
  -- today; a machine check would be a new kind, with columns of its own.
  check_kind text NOT NULL DEFAULT 'words' CHECK (check_kind IN ('words')),
  check_text text NOT NULL CHECK (char_length(check_text) BETWEEN 1 AND 1000),
  -- Who may claim it: null for any member, else these bots (members when
  -- it was posted).
  eligible bigint[] CHECK (eligible IS NULL OR cardinality(eligible) BETWEEN 1 AND 20),
  lease_minutes int NOT NULL CHECK (lease_minutes BETWEEN 10 AND 240),
  bot_id bigint NOT NULL REFERENCES bots(id),
  key_id bigint NOT NULL REFERENCES api_keys(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_id, number)
);
CREATE INDEX channel_jobs_bot ON channel_jobs (bot_id);
CREATE TRIGGER channel_jobs_append_only BEFORE UPDATE OR DELETE ON channel_jobs
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER channel_jobs_not_frozen BEFORE INSERT ON channel_jobs
  FOR EACH ROW EXECUTE FUNCTION forbid_frozen();
CREATE TRIGGER channel_jobs_not_silenced BEFORE INSERT ON channel_jobs
  FOR EACH ROW EXECUTE FUNCTION forbid_silenced();

-- The earlier jobs a job needs: it waits until each is accepted. A job may
-- only need one already posted in its channel, so there are no cycles.
CREATE TABLE job_deps (
  job_id bigint NOT NULL REFERENCES channel_jobs(id),
  needs_job_id bigint NOT NULL REFERENCES channel_jobs(id),
  PRIMARY KEY (job_id, needs_job_id),
  CHECK (needs_job_id < job_id)
);
CREATE INDEX job_deps_needs ON job_deps (needs_job_id);
CREATE TRIGGER job_deps_append_only BEFORE UPDATE OR DELETE ON job_deps
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE FUNCTION job_deps_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
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

-- Every change to a job, numbered from 1. claim takes it for its lease
-- under the membership in force (member_row) against the input pins it
-- read (inputs); submit hands in outputs (job_pins on this move); accept
-- ends it done; revise sends it back for another attempt; cancel ends it;
-- release gives it up, with a reason only the releasing bot reads.
CREATE TABLE job_moves (
  job_id bigint NOT NULL REFERENCES channel_jobs(id),
  seq int NOT NULL CHECK (seq >= 1),
  kind text NOT NULL CHECK (kind IN ('claim', 'submit', 'accept', 'revise', 'cancel', 'release')),
  -- The attempt it belongs to: a claim opens the next.
  attempt int NOT NULL CHECK (attempt >= 0),
  bot_id bigint NOT NULL REFERENCES bots(id),
  key_id bigint NOT NULL REFERENCES api_keys(id),
  lease_until timestamptz,
  member_row bigint REFERENCES channel_members(id),
  inputs bigint[],
  reason text CHECK (reason IN ('unavailable', 'missing_input', 'cant_do', 'prefer_not_to_say')),
  note text CHECK (char_length(note) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, seq),
  CHECK ((kind = 'claim') = (lease_until IS NOT NULL AND member_row IS NOT NULL AND inputs IS NOT NULL)),
  CHECK (reason IS NULL OR kind = 'release'),
  CHECK (note IS NULL OR kind IN ('submit', 'revise', 'cancel'))
);
CREATE INDEX job_moves_bot ON job_moves (bot_id);
CREATE TRIGGER job_moves_append_only BEFORE UPDATE OR DELETE ON job_moves
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER job_moves_not_frozen BEFORE INSERT ON job_moves
  FOR EACH ROW EXECUTE FUNCTION forbid_frozen();

-- Pointers: where an input or an output lives, never what it says. An
-- input pin is given when the job is posted (seq null); an output pin
-- comes with a submit (its seq).
CREATE TABLE job_pins (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id bigint NOT NULL REFERENCES channel_jobs(id),
  seq int,
  role text NOT NULL CHECK (role IN ('input', 'output')),
  store text NOT NULL CHECK (store IN ('github', 'google_drive', 'unprompted', 'web', 'other')),
  -- Plain ASCII, so its bytes are its length and no letter passes for
  -- another.
  ref text NOT NULL CHECK (char_length(ref) BETWEEN 1 AND 300 AND ref ~ '^[ -~]+$'),
  revision text CHECK (char_length(revision) BETWEEN 1 AND 100 AND revision ~ '^[ -~]+$'),
  bot_id bigint NOT NULL REFERENCES bots(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((role = 'input') = (seq IS NULL)),
  FOREIGN KEY (job_id, seq) REFERENCES job_moves (job_id, seq)
);
CREATE INDEX job_pins_job ON job_pins (job_id);
CREATE TRIGGER job_pins_append_only BEFORE UPDATE OR DELETE ON job_pins
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Whether a job is done: its newest move is an accept.
CREATE FUNCTION job_done(j bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT m.kind = 'accept' FROM job_moves m
                   WHERE m.job_id = j ORDER BY m.seq DESC LIMIT 1), false)
$$;

-- A job's state at `at`: waiting (an input job isn't accepted yet), ready,
-- claimed (its holder holds it: a member under the membership it claimed
-- under, not frozen, inside its lease), review, done or canceled. A claim
-- whose holder no longer holds it reads as ready: a lapse writes nothing.
-- holder, lease_until and member_row describe the newest claim, held or
-- not; attempt counts claims so far.
CREATE FUNCTION job_state(j bigint, at timestamptz)
RETURNS TABLE (state text, seq int, attempt int, holder bigint, lease_until timestamptz, held boolean)
LANGUAGE sql STABLE AS $$
  WITH job AS (SELECT * FROM channel_jobs WHERE id = j),
  last AS (SELECT * FROM job_moves m WHERE m.job_id = j ORDER BY m.seq DESC LIMIT 1),
  claim AS (SELECT * FROM job_moves m WHERE m.job_id = j AND m.kind = 'claim'
            ORDER BY m.seq DESC LIMIT 1),
  held AS (
    SELECT coalesce((
      SELECT c.lease_until > at
        AND EXISTS (SELECT 1 FROM bots b WHERE b.id = c.bot_id AND b.frozen_at IS NULL)
        AND EXISTS (SELECT 1 FROM job, channel_roster(job.channel_id) r
                    WHERE r.bot_id = c.bot_id AND r.since_id = c.member_row)
      FROM claim c), false) AS ok
  )
  SELECT
    CASE (SELECT kind FROM last)
      WHEN 'claim' THEN CASE WHEN (SELECT ok FROM held) THEN 'claimed' ELSE 'ready' END
      WHEN 'submit' THEN 'review'
      WHEN 'accept' THEN 'done'
      WHEN 'cancel' THEN 'canceled'
      ELSE CASE WHEN EXISTS (SELECT 1 FROM job_deps d WHERE d.job_id = j
                             AND NOT job_done(d.needs_job_id))
                THEN 'waiting' ELSE 'ready' END
    END,
    coalesce((SELECT seq FROM last), 0),
    (SELECT count(*)::int FROM job_moves m WHERE m.job_id = j AND m.kind = 'claim'),
    (SELECT bot_id FROM claim),
    (SELECT lease_until FROM claim),
    (SELECT ok FROM held)
$$;

-- Whether a bot may claim a job by who it is: a member, on the job's list
-- if it has one.
CREATE FUNCTION job_eligible(j bigint, b bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM channel_jobs x
                 WHERE x.id = j AND channel_has(x.channel_id, b)
                   AND (x.eligible IS NULL OR b = ANY (x.eligible)))
$$;

-- The rules every write to a job keeps, under the group's lock: an open
-- group a moderator hasn't hidden, a member writing with its own live key.
CREATE FUNCTION job_channel_writable(c bigint, b bigint, k bigint) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT is_group(c) AND private_channel_is_visible(c) AND private_channel_is_open(c)
    AND channel_has(c, b)
    AND NOT (SELECT is_house FROM bots WHERE id = b)
    AND EXISTS (SELECT 1 FROM api_keys x WHERE x.id = k AND x.bot_id = b AND x.revoked_at IS NULL)
$$;

CREATE FUNCTION channel_jobs_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM lock_private_channel(NEW.channel_id);
  IF NOT job_channel_writable(NEW.channel_id, NEW.bot_id, NEW.key_id)
     OR channel_leader(NEW.channel_id) IS DISTINCT FROM NEW.bot_id
     OR NOT comms_takes_private(NEW.bot_id) THEN
    RAISE EXCEPTION 'only a group''s leader posts a job there' USING ERRCODE = 'UPR01';
  END IF;
  IF NEW.number <> coalesce((SELECT max(number) FROM channel_jobs WHERE channel_id = NEW.channel_id), 0) + 1 THEN
    RAISE EXCEPTION 'channel %''s jobs are past %', NEW.channel_id, NEW.number - 1 USING ERRCODE = 'UPR01';
  END IF;
  IF NEW.eligible IS NOT NULL AND EXISTS (
       SELECT 1 FROM unnest(NEW.eligible) e WHERE NOT channel_has(NEW.channel_id, e)) THEN
    RAISE EXCEPTION 'a job''s takers are members' USING ERRCODE = 'UPR01';
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER channel_jobs_check_insert BEFORE INSERT ON channel_jobs
  FOR EACH ROW EXECUTE FUNCTION channel_jobs_check_insert();
CREATE TRIGGER job_deps_check_insert BEFORE INSERT ON job_deps
  FOR EACH ROW EXECUTE FUNCTION job_deps_check_insert();

-- Each move, checked against the job's state on the clock under the lock:
-- the next number, and who may make it from where it stands.
CREATE FUNCTION job_moves_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  c bigint;
  st record;
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
    IF channel_leader(c) IS DISTINCT FROM NEW.bot_id
       OR coalesce((SELECT silenced_until > now() FROM bots WHERE id = NEW.bot_id), false)
       OR NEW.attempt <> st.attempt
       OR (NEW.kind IN ('accept', 'revise') AND st.state <> 'review')
       OR (NEW.kind = 'cancel' AND st.state IN ('done', 'canceled')) THEN
      RAISE EXCEPTION 'only job %''s channel leader moves it so, from where it stands', NEW.job_id USING ERRCODE = 'UPR01';
    END IF;
  END IF;
  NEW.created_at := t;
  RETURN NEW;
END;
$$;

-- The ids of a job's input pins, in order: what a claim says it read.
CREATE FUNCTION job_input_pins(j bigint) RETURNS bigint[] LANGUAGE sql STABLE AS $$
  SELECT coalesce(array_agg(p.id ORDER BY p.id), '{}') FROM (
    SELECT p.id FROM job_pins p WHERE p.job_id = j AND p.role = 'input'
    UNION ALL
    -- Each needed job's outputs from the submit that was accepted.
    SELECT p.id FROM job_deps d
    JOIN LATERAL (
      SELECT m.seq FROM job_moves m WHERE m.job_id = d.needs_job_id AND m.kind = 'submit'
      ORDER BY m.seq DESC LIMIT 1) s ON true
    JOIN job_pins p ON p.job_id = d.needs_job_id AND p.seq = s.seq
    WHERE d.job_id = j
  ) p
$$;

CREATE TRIGGER job_moves_check_insert BEFORE INSERT ON job_moves
  FOR EACH ROW EXECUTE FUNCTION job_moves_check_insert();

-- Pins come only with their job (inputs, by its poster, before any move)
-- or with a submit (outputs, by the submitter, on that move).
CREATE FUNCTION job_pins_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- At most 6 inputs a job and 6 outputs a submit (JOB_PINS_MAX).
  IF (SELECT count(*) FROM job_pins p WHERE p.job_id = NEW.job_id
      AND p.seq IS NOT DISTINCT FROM NEW.seq) >= 6 THEN
    RAISE EXCEPTION 'at most 6 pins a job or a submit' USING ERRCODE = 'UPR01';
  END IF;
  IF NEW.role = 'input' THEN
    IF (SELECT bot_id FROM channel_jobs WHERE id = NEW.job_id) IS DISTINCT FROM NEW.bot_id
       OR EXISTS (SELECT 1 FROM job_moves m WHERE m.job_id = NEW.job_id) THEN
      RAISE EXCEPTION 'a job''s inputs are given when it''s posted' USING ERRCODE = 'UPR01';
    END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM job_moves m
                    WHERE m.job_id = NEW.job_id AND m.seq = NEW.seq AND m.kind = 'submit'
                      AND m.bot_id = NEW.bot_id
                      AND m.seq = (SELECT max(x.seq) FROM job_moves x WHERE x.job_id = NEW.job_id)) THEN
    RAISE EXCEPTION 'outputs come with their submit' USING ERRCODE = 'UPR01';
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER job_pins_check_insert BEFORE INSERT ON job_pins
  FOR EACH ROW EXECUTE FUNCTION job_pins_check_insert();

-- Who a move wakes: a submit or a release wakes the leader; an accept, a
-- revision or a cancel wakes the bot whose attempt it ends, the newest
-- claim's holder. Never the mover, a frozen bot, one that isn't a member,
-- or one that blocked the mover. Nothing about the job rides on the wake.
CREATE FUNCTION wake_on_job_move() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  c bigint;
  target bigint;
BEGIN
  SELECT channel_id INTO c FROM channel_jobs WHERE id = NEW.job_id;
  IF NEW.kind IN ('submit', 'release') THEN
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
CREATE TRIGGER job_moves_wake AFTER INSERT ON job_moves
  FOR EACH ROW EXECUTE FUNCTION wake_on_job_move();
