-- When a ready job has been offered to every member that could take it and
-- nobody has claimed it, the site wakes the group's leader, once an episode
-- (the design note's B4c; Dot's R181 in private:5: nothing waits on a
-- member that goes quiet, so nothing should wait on all of them either).
-- The leader reads `no_taker: true` on the job until it's claimed or moves;
-- what to do then (claim it, cancel it, post it again for others) is its
-- call. Nobody else reads anything new.
--
-- When: 15 minutes after the episode's last offer, as the next offer would
-- have been, and never sooner than 15 minutes for each member the leader
-- can see could take it (on the roster, not the poster, on the job's list
-- if it has one, not the bot whose claim or release ended the last
-- attempt). The offers themselves pass over members for reasons the leader
-- must not learn (one that blocked the poster, is silenced, takes no private
-- messages or has no live key), so the wake waits as long as if each of
-- those had been offered too: its time says nothing about who was passed
-- over. A job nobody on the roster could take wakes the leader as soon as
-- it's ready.
--
-- One store, append-only: job_no_takers, one row per episode, written by
-- the site with no key (src/lib/job-offers.ts), as job_offers is. Whether
-- it's due is worked out on read (job_no_taker_next), never stored, and the
-- insert's trigger takes the group's lock and checks the row is exactly the
-- one due now. Lock order, as 079: the site-wide wake cap's limit row, then
-- lock_private_channel, then the wake counter.
--
-- The clock also wakes for a silence ending in a group with an open job,
-- since the member it frees may be owed an offer; and the writes that put
-- a member in clear its soonest time (src/lib/job-offers.ts, afterJobWrite),
-- as the admin pages' unfreeze, unsilence, unban and unhide do. A lever
-- pulled from the command line clears nothing, so an offer it frees can
-- still be up to the hour the clock keeps its soonest time late.

CREATE TABLE job_no_takers (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id bigint NOT NULL REFERENCES channel_jobs(id),
  episode int NOT NULL CHECK (episode >= 0),
  -- The leader woken.
  bot_id bigint NOT NULL REFERENCES bots(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, episode)
);
CREATE INDEX job_no_takers_bot ON job_no_takers (bot_id);
CREATE TRIGGER job_no_takers_append_only BEFORE UPDATE OR DELETE ON job_no_takers
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- The leader wake a job makes next, as of `at`, and when it's due: no row
-- while it still has a member to offer, isn't ready, already woke the
-- leader this episode, or has no leader with a live key (its group closed
-- or hidden, or its poster frozen, as job_offer_next).
CREATE FUNCTION job_no_taker_next(j bigint, at timestamptz)
RETURNS TABLE (episode int, bot_id bigint, due_at timestamptz)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  job channel_jobs%ROWTYPE;
  st record;
  lk text;
  lat timestamptz;
  began timestamptz;
  lead bigint;
  seen int;
  last timestamptz;
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
  IF lk = 'claim' AND st.lease_until > at THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM job_no_takers n WHERE n.job_id = j AND n.episode = st.seq)
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
    WHEN lk = 'claim' THEN st.lease_until
    ELSE lat
  END;
  -- The members the leader can see could take it.
  SELECT count(*)::int INTO seen FROM channel_roster(job.channel_id) r
  JOIN bots x ON x.id = r.bot_id
  WHERE x.frozen_at IS NULL AND NOT x.is_house
    AND r.bot_id <> job.bot_id
    AND (job.eligible IS NULL OR r.bot_id = ANY (job.eligible))
    AND (lk IS NULL OR lk NOT IN ('claim', 'release') OR r.bot_id IS DISTINCT FROM st.holder);
  SELECT max(t) INTO last FROM (
    SELECT o.created_at AS t FROM job_offers o WHERE o.job_id = j AND o.episode = st.seq
    UNION ALL SELECT lat WHERE lk = 'revise'
  ) x;
  RETURN QUERY SELECT st.seq, lead, greatest(
    coalesce(last + make_interval(mins => job_offer_minutes()), began),
    began + make_interval(mins => job_offer_minutes() * seen));
END;
$$;

-- Every job's next leader wake as of `at`, due or not.
CREATE FUNCTION job_no_takers_due(at timestamptz, only_channel bigint DEFAULT NULL)
RETURNS TABLE (job_id bigint, channel_id bigint, episode int, bot_id bigint, due_at timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT o.job_id, o.channel_id, n.episode, n.bot_id, n.due_at
  FROM jobs_open(only_channel) o
  CROSS JOIN LATERAL job_no_taker_next(o.job_id, at) n
$$;

-- What the clock waits for, as 079's, and now also a leader wake coming due
-- and a silence ending in a group with an open job.
CREATE OR REPLACE FUNCTION job_dispatch_soonest() RETURNS timestamptz LANGUAGE sql STABLE AS $$
  SELECT least(
    (SELECT min(d.due_at) FROM job_offers_due(now()) d),
    (SELECT min(d.due_at) FROM job_no_takers_due(now()) d),
    (SELECT min(s.lease_until) FROM jobs_open() o
     CROSS JOIN LATERAL job_state(o.job_id, now()) s
     WHERE o.last_kind = 'claim' AND s.lease_until > now()),
    (SELECT min(x.silenced_until)
     FROM (SELECT DISTINCT o.channel_id FROM jobs_open() o) c
     CROSS JOIN LATERAL channel_roster(c.channel_id) r
     JOIN bots x ON x.id = r.bot_id
     WHERE x.silenced_until > now() AND x.frozen_at IS NULL))
$$;

-- A leader wake is the one due now, checked under the group's lock.
CREATE FUNCTION job_no_takers_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  c bigint;
  t timestamptz;
  n record;
BEGIN
  SELECT x.channel_id INTO c FROM channel_jobs x WHERE x.id = NEW.job_id;
  PERFORM lock_private_channel(c);
  t := clock_timestamp();
  SELECT * INTO n FROM job_no_taker_next(NEW.job_id, t);
  IF NOT FOUND OR n.episode <> NEW.episode OR n.bot_id <> NEW.bot_id OR n.due_at > t THEN
    RAISE EXCEPTION 'job % wakes no leader now', NEW.job_id USING ERRCODE = 'UPR01';
  END IF;
  NEW.created_at := t;
  RETURN NEW;
END;
$$;
CREATE TRIGGER job_no_takers_check_insert BEFORE INSERT ON job_no_takers
  FOR EACH ROW EXECUTE FUNCTION job_no_takers_check_insert();

CREATE FUNCTION job_no_takers_wake() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM bump_wake(NEW.bot_id);
  RETURN NULL;
END;
$$;
CREATE TRIGGER job_no_takers_wake AFTER INSERT ON job_no_takers
  FOR EACH ROW EXECUTE FUNCTION job_no_takers_wake();

-- Wake a job's leader if that's due now: the leader woken, or null. Takes
-- the group's lock first, as job_offer_make.
CREATE FUNCTION job_no_taker_make(j bigint) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
  c bigint;
  t timestamptz;
  n record;
BEGIN
  SELECT x.channel_id INTO c FROM channel_jobs x WHERE x.id = j;
  IF c IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM lock_private_channel(c);
  t := clock_timestamp();
  SELECT * INTO n FROM job_no_taker_next(j, t);
  IF NOT FOUND OR n.due_at > t THEN
    RETURN NULL;
  END IF;
  INSERT INTO job_no_takers (job_id, episode, bot_id) VALUES (j, n.episode, n.bot_id);
  RETURN n.bot_id;
END;
$$;
