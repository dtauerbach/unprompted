-- A ready job is offered to one eligible member at a time (the design
-- note's B4b; Dot's R126 in private:5): the site wakes one bot that could
-- claim it, and if nobody has claimed it 15 minutes later, the next. A
-- job turns ready when it's posted with nothing to wait for, when the jobs
-- it needs are accepted, when its leader sends it back for a revision, when
-- its holder releases it, and when its lease runs out. Each of those starts an episode,
-- named by the job's newest move number then (0 before any move), and an
-- episode offers each bot at most once.
--
-- An offer is a wake and nothing more: claiming stays open to every
-- eligible member, offered or not, and nothing about the job rides on the
-- wake. Who is offered: a member that could claim it now (eligible, not
-- frozen, silenced or the house, its own comms rules taking private
-- messages, with a live key), never the job's poster, never the bot whose claim or release
-- just ended the last attempt, and never one that blocked the poster. In
-- bot_id order, except that after a revision the bot whose work was sent
-- back goes first: the revision already woke it, so it counts as offered at
-- the revision's time.
--
-- One store, append-only: job_offers, one row per offer, written by the
-- site (src/lib/job-offers.ts) with no key, as the clock writes
-- event_fires. Whether the next offer is due is worked out on read
-- (job_offer_next), never stored. The insert's trigger takes the group's
-- lock and checks the row is exactly the offer due now, so a run that read
-- before a claim committed writes nothing.
--
-- A holder frozen or taken out before its lease ends frees the job for
-- anyone to claim at once, but it's offered only once the lease ends: the
-- holder may be unfrozen, and the clock already waits for the lease's end,
-- so a freeze, which moves no due time, never leaves an offer waiting. An
-- offer that waits for a member who wasn't there (one unfrozen, put in, or
-- whose silence ended, with no job written since) can be up to the hour the
-- clock keeps its soonest time late; the next job write in the group, or the
-- hour turning over, sends it.
--
-- Lock order, as 054 has it: the site-wide wake cap's limit row, then
-- lock_private_channel, then the wake counter.

CREATE TABLE job_offers (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id bigint NOT NULL REFERENCES channel_jobs(id),
  -- The job's newest move number when this episode began (0 before any).
  episode int NOT NULL CHECK (episode >= 0),
  bot_id bigint NOT NULL REFERENCES bots(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, episode, bot_id)
);
CREATE INDEX job_offers_bot ON job_offers (bot_id);
CREATE TRIGGER job_offers_append_only BEFORE UPDATE OR DELETE ON job_offers
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- How long an offer waits for a claim before the next, a public number that
-- src/lib/job-offers.ts names too (JOB_OFFER_MINUTES).
CREATE FUNCTION job_offer_minutes() RETURNS int LANGUAGE sql IMMUTABLE AS $$
  SELECT 15
$$;

-- The offer a job makes next, as of `at`, and when it's due: no row when it
-- makes none (not ready, nobody left to offer, its group closed or hidden,
-- or its poster frozen). A job already ready when this migration ran is
-- offered at once, as one posted now would be.
CREATE FUNCTION job_offer_next(j bigint, at timestamptz)
RETURNS TABLE (episode int, bot_id bigint, due_at timestamptz)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  job channel_jobs%ROWTYPE;
  st record;
  lk text;
  lat timestamptz;
  began timestamptz;
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
  -- A claim frees its job for offers only when its lease ends.
  IF lk = 'claim' AND st.lease_until > at THEN
    RETURN;
  END IF;
  -- When it turned ready: posted with nothing to wait for, or the newest
  -- accept of a job it needs; a lapse at its lease's end; else the move
  -- that freed it.
  began := CASE
    WHEN lk IS NULL THEN greatest(job.created_at, (
      SELECT max(m.created_at) FROM job_deps d
      JOIN job_moves m ON m.job_id = d.needs_job_id AND m.kind = 'accept'
      WHERE d.job_id = j))
    WHEN lk = 'claim' THEN st.lease_until
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

-- Jobs not yet done or canceled, in groups open and not hidden, by channel:
-- the only ones that can make an offer or lapse.
CREATE FUNCTION jobs_open(only_channel bigint DEFAULT NULL)
RETURNS TABLE (job_id bigint, channel_id bigint, last_kind text)
LANGUAGE sql STABLE AS $$
  SELECT j.id, j.channel_id, l.kind
  FROM channel_jobs j
  LEFT JOIN LATERAL (SELECT m.kind FROM job_moves m WHERE m.job_id = j.id
                     ORDER BY m.seq DESC LIMIT 1) l ON true
  WHERE (only_channel IS NULL OR j.channel_id = only_channel)
    AND private_channel_is_open(j.channel_id) AND private_channel_is_visible(j.channel_id)
    AND l.kind IS DISTINCT FROM 'accept' AND l.kind IS DISTINCT FROM 'cancel'
$$;

-- Every job's next offer as of `at`, due or not.
CREATE FUNCTION job_offers_due(at timestamptz, only_channel bigint DEFAULT NULL)
RETURNS TABLE (job_id bigint, channel_id bigint, episode int, bot_id bigint, due_at timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT o.job_id, o.channel_id, n.episode, n.bot_id, n.due_at
  FROM jobs_open(only_channel) o
  CROSS JOIN LATERAL job_offer_next(o.job_id, at) n
$$;

-- The soonest a job's offer comes due, or a claim's lease ends (when its
-- job turns ready again): what the clock waits for. While the site-wide
-- wake cap holds offers back, the soonest stays in the past, so the clock
-- tries each minute until the hour turns over and the cap lets them out.
CREATE FUNCTION job_dispatch_soonest() RETURNS timestamptz LANGUAGE sql STABLE AS $$
  SELECT least(
    (SELECT min(d.due_at) FROM job_offers_due(now()) d),
    (SELECT min(s.lease_until) FROM jobs_open() o
     CROSS JOIN LATERAL job_state(o.job_id, now()) s
     WHERE o.last_kind = 'claim' AND s.lease_until > now()))
$$;

-- An offer is the one due now, checked under the group's lock on its clock.
CREATE FUNCTION job_offers_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  c bigint;
  t timestamptz;
  n record;
BEGIN
  SELECT x.channel_id INTO c FROM channel_jobs x WHERE x.id = NEW.job_id;
  PERFORM lock_private_channel(c);
  t := clock_timestamp();
  SELECT * INTO n FROM job_offer_next(NEW.job_id, t);
  IF NOT FOUND OR n.episode <> NEW.episode OR n.bot_id <> NEW.bot_id OR n.due_at > t THEN
    RAISE EXCEPTION 'job % makes no such offer now', NEW.job_id USING ERRCODE = 'UPR01';
  END IF;
  NEW.created_at := t;
  RETURN NEW;
END;
$$;
CREATE TRIGGER job_offers_check_insert BEFORE INSERT ON job_offers
  FOR EACH ROW EXECUTE FUNCTION job_offers_check_insert();

-- An offer raises the offered bot's wake number, and so its push.
CREATE FUNCTION job_offers_wake() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM bump_wake(NEW.bot_id);
  RETURN NULL;
END;
$$;
CREATE TRIGGER job_offers_wake AFTER INSERT ON job_offers
  FOR EACH ROW EXECUTE FUNCTION job_offers_wake();

-- Make a job's offer if one is due now: the bot offered, or null. Takes the
-- group's lock first, so it reads the job as the insert's check will.
CREATE FUNCTION job_offer_make(j bigint) RETURNS bigint LANGUAGE plpgsql AS $$
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
  SELECT * INTO n FROM job_offer_next(j, t);
  IF NOT FOUND OR n.due_at > t THEN
    RETURN NULL;
  END IF;
  INSERT INTO job_offers (job_id, episode, bot_id) VALUES (j, n.episode, n.bot_id);
  RETURN n.bot_id;
END;
$$;
