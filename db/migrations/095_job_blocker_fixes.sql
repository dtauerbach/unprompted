-- Fable's review of #220 (090's job blockers) after it merged, re-checked
-- on top of 092 (tests in src/test/job-blocker-fixes.test.ts). Four
-- changes:
--
-- 1. A member's word that it can't open a job's inputs stands only while
--    the bot is still in the group under the membership it said it under:
--    a bot that leaves and comes back reads as one that never said it, and
--    may be asked again if it wasn't asked this episode. job_blockers_live
--    keeps its shape, so job_blocked, job_all_blocked and the offers
--    follow. A new key doesn't end it: the leader's flag goes by roster
--    facts only (090), and a key that ended it would tell the leader that
--    a member reconnected. A bot that connects again reads its word as
--    cant_read and may still claim the job.
--
-- 2. A leader woken once in an episode because nobody took the job is woken
--    once more if every member that could take it then says it can't open
--    the inputs: only the leader can fix access (pilot case 4), and the
--    first wake said only that nobody took it. Each wake has its reason
--    (`no_taker` or `inputs_unreadable`), with one wake and at most one
--    mark of each reason an episode, so a leader hears each at most once.
--    Rows written before this file have the reason `no_taker`, so a job
--    whose leader was already woken for its blocked inputs in an episode
--    still open now may be woken for them once more.
--
-- 3. A claim that lapsed is nobody's write. 092 named the claimer as what
--    left every taker blocked, so a leader that claimed its own job and let
--    the lease run out got a mark and no wake. Now the claim's end is the
--    move, at the time it ended, by whoever took the holder out before its
--    lease ran out while it wasn't frozen (a person's take-out has no bot);
--    a lapse, or taking out a holder already frozen, is nobody's. That's
--    for the blocked cause; for nobody taking it, the own-write test stays
--    whose write made it ready (081), so a leader's take-out of its holder
--    before the lease ran out is its own, frozen holder or not.
--
-- 4. What left every taker blocked is the newest change that took a taker
--    away, judged by the state just before it, not by the state when the
--    pass runs. So taking out a member already frozen, or one that had
--    already said it can't open the inputs, is no cause; and a freeze is
--    read from bot_freeze_changes (091), so it stays a cause after the
--    frozen bot is taken out.
--
-- Two smaller ones: the leader's wake time counts only the takers' words,
-- and a job read works out whether every taker is blocked only for the
-- leader, who alone reads it (src/lib/jobs.ts).
--
-- 091's freeze record is backfilled only for bots frozen when it ran, so a
-- bot frozen, taken out and unfrozen before then left no record: its
-- leaving reads as an unfrozen one, for that old data only. A freeze moved
-- from one time to another writes no row, so the record keeps when the
-- freeze began; the tests that move time shift the record with it.

-- 1. A blocker stands under the membership it was said under.
CREATE OR REPLACE FUNCTION job_blockers_live(j bigint)
RETURNS TABLE (bot_id bigint, created_at timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT x.bot_id, x.created_at FROM (
    SELECT DISTINCT ON (b.bot_id) b.bot_id, b.created_at, b.inputs
    FROM job_blockers b WHERE b.job_id = j
    ORDER BY b.bot_id, b.id DESC
  ) x
  JOIN channel_jobs cj ON cj.id = j
  WHERE x.inputs = job_input_pins(j)
    AND NOT EXISTS (SELECT 1 FROM job_moves m WHERE m.job_id = j AND m.bot_id = x.bot_id
                    AND m.kind = 'claim' AND m.created_at >= x.created_at)
    AND channel_member_at(cj.channel_id, x.bot_id, x.created_at)
        = (SELECT r.since_id FROM channel_roster(cj.channel_id) r WHERE r.bot_id = x.bot_id)
$$;

-- Whether bot b's word stood just before time t, by the same rules.
CREATE FUNCTION job_blocked_before(j bigint, b bigint, t timestamptz) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM channel_jobs cj
    CROSS JOIN LATERAL (
      SELECT x.created_at, x.inputs FROM job_blockers x
      WHERE x.job_id = j AND x.bot_id = b AND x.created_at < t
      ORDER BY x.id DESC LIMIT 1) x
    WHERE cj.id = j AND x.inputs = job_input_pins(j)
      AND NOT EXISTS (SELECT 1 FROM job_moves m WHERE m.job_id = j AND m.bot_id = b
                      AND m.kind = 'claim' AND m.created_at >= x.created_at
                      AND m.created_at < t)
      AND channel_member_at(cj.channel_id, b, x.created_at)
          = channel_member_at(cj.channel_id, b, t - interval '1 microsecond'))
$$;

-- 2. Each wake and mark has its reason.
ALTER TABLE job_no_takers ADD COLUMN reason text NOT NULL DEFAULT 'no_taker'
  CHECK (reason IN ('no_taker', 'inputs_unreadable'));
ALTER TABLE job_no_takers DROP CONSTRAINT job_no_takers_job_id_episode_woken_key;
ALTER TABLE job_no_takers ADD CONSTRAINT job_no_takers_one_each
  UNIQUE (job_id, episode, reason, woken);

DROP FUNCTION job_no_taker_next(bigint, timestamptz);
CREATE FUNCTION job_no_taker_next(j bigint, at timestamptz)
RETURNS TABLE (episode int, bot_id bigint, due_at timestamptz, wakes boolean, reason text)
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
  endby bigint;
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
    -- Whose write ended the claim: whoever took the holder out, only if it
    -- was before the lease ran out and the holder wasn't frozen then, since
    -- taking out a frozen holder takes no one away (Fable's review of 095).
    IF gone IS NOT NULL AND gone < st.lease_until
       AND NOT bot_was_frozen(lby, gone) THEN
      endby := gby;
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM job_offer_next(j, at)) THEN
    RETURN;
  END IF;
  lead := channel_leader(job.channel_id);
  IF lead IS NULL OR NOT EXISTS (
    SELECT 1 FROM api_keys k WHERE k.bot_id = lead AND k.revoked_at IS NULL) THEN
    RETURN;
  END IF;
  -- Every member the leader can see could take it said it can't open this
  -- input set: the leader is told at once, when the last one said so (pilot
  -- case 4), once an episode for this reason, whatever it heard before.
  IF job_all_blocked(j) THEN
    IF EXISTS (SELECT 1 FROM job_no_takers n WHERE n.job_id = j AND n.episode = st.seq
               AND n.reason = 'inputs_unreadable' AND n.woken) THEN
      RETURN;
    END IF;
    -- When the last taker said so: only the takers' words count, never the
    -- poster's or a frozen member's (Fable's nit).
    began := (SELECT max(bl.created_at) FROM job_blockers_live(j) bl
              JOIN bots y ON y.id = bl.bot_id
              WHERE y.frozen_at IS NULL AND NOT y.is_house AND bl.bot_id <> job.bot_id
                AND (job.eligible IS NULL OR bl.bot_id = ANY (job.eligible)));
    -- As 082 has it, nothing wakes a leader for its own write. Here that's
    -- the newest change that took a taker away, judged by the state just
    -- before it: a member's own cant_read (the leader's own, when it could
    -- take the job itself), the episode's move (a revision, a release, or
    -- a claim's end: whoever took the holder out, or nobody when its lease
    -- ran out first or the holder was already frozen), a leaving or take-out of a member that could take it then
    -- (unfrozen, and hadn't said so; a person's take-out has no bot), or a
    -- freeze of one, which is never the leader's write. Judged by order
    -- alone, never by how long ago, so a later pass reads the same. When it
    -- was the leader's own write, the leader gets the mark alone, once.
    SELECT x.who INTO cause FROM (
      SELECT bl.bot_id AS who, bl.created_at AS t, 0 AS o FROM job_blockers_live(j) bl
      UNION ALL
      SELECT CASE WHEN lk = 'claim' THEN endby ELSE lby END,
             CASE WHEN lk = 'claim' THEN least(gone, st.lease_until) ELSE lat END, 1
      WHERE lat IS NOT NULL
      UNION ALL
      SELECT cm.by_bot_id, cm.created_at, 2 FROM channel_members cm
      WHERE cm.channel_id = job.channel_id AND NOT cm.member
        AND cm.bot_id <> job.bot_id
        AND (job.eligible IS NULL OR cm.bot_id = ANY (job.eligible))
        AND channel_member_at(job.channel_id, cm.bot_id,
                              cm.created_at - interval '1 microsecond') IS NOT NULL
        AND NOT bot_was_frozen(cm.bot_id, cm.created_at)
        AND NOT job_blocked_before(j, cm.bot_id, cm.created_at)
      UNION ALL
      SELECT NULL::bigint, f.at, 3 FROM bot_freeze_changes f
      WHERE f.frozen AND f.bot_id <> job.bot_id
        AND f.bot_id IN (SELECT y.bot_id FROM channel_members y
                         WHERE y.channel_id = job.channel_id)
        AND (job.eligible IS NULL OR f.bot_id = ANY (job.eligible))
        AND channel_member_at(job.channel_id, f.bot_id, f.at) IS NOT NULL
        AND NOT job_blocked_before(j, f.bot_id, f.at)
    ) x ORDER BY x.t DESC, x.o DESC, x.who LIMIT 1;
    own := coalesce(cause = lead, false);
    IF own AND EXISTS (SELECT 1 FROM job_no_takers n
                       WHERE n.job_id = j AND n.episode = st.seq
                         AND n.reason = 'inputs_unreadable' AND NOT n.woken) THEN
      RETURN;
    END IF;
    RETURN QUERY SELECT st.seq, lead, began, NOT own, 'inputs_unreadable'::text;
    RETURN;
  END IF;
  -- One no_taker wake an episode. A mark the leader's own write got without
  -- a wake stands until a member turns up and is offered it, after which
  -- nobody taking it wakes the leader as any other episode would.
  IF EXISTS (SELECT 1 FROM job_no_takers n WHERE n.job_id = j AND n.episode = st.seq
             AND n.reason = 'no_taker' AND n.woken)
     OR EXISTS (SELECT 1 FROM job_no_takers n WHERE n.job_id = j AND n.episode = st.seq
                AND n.reason = 'no_taker'
                AND NOT EXISTS (
                  SELECT 1 FROM job_offers o WHERE o.job_id = j AND o.episode = st.seq
                    AND o.created_at > n.created_at)) THEN
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
    -- A member that said it can't open the inputs before it was asked this
    -- episode is never asked, so it adds no ask's time (092); one asked
    -- first still counts, since the next ask started only when it said so.
    -- A bot gone from the roster is judged by whether its word stood when
    -- it went, since its word ends with its membership (1, above).
    AND (NOT (job_blocked(j, cm.bot_id)
              OR (NOT EXISTS (SELECT 1 FROM channel_roster(job.channel_id) r
                              WHERE r.bot_id = cm.bot_id)
                  AND job_blocked_before(j, cm.bot_id, (
                    SELECT max(y.created_at) FROM channel_members y
                    WHERE y.channel_id = job.channel_id AND y.bot_id = cm.bot_id
                      AND NOT y.member))))
         OR EXISTS (SELECT 1 FROM job_offers o
                    WHERE o.job_id = j AND o.episode = st.seq AND o.bot_id = cm.bot_id)
         OR (lk = 'revise' AND cm.bot_id = st.holder))
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
      -- A leader that took out the holder before its lease ran out made it
      -- ready, frozen holder or not (081): its own write. A person's
      -- take-out has no bot, and a lapse is nobody's: never the leader's.
      -- (Taking no one away, endby, is the test for the blocked cause only.)
      WHEN lk = 'claim' THEN gone < st.lease_until AND coalesce(gby = lead, false)
      ELSE lby = lead
    END),
    'no_taker'::text;
END;
$$;

-- The row written is the one due now, with its reason.
CREATE OR REPLACE FUNCTION job_no_takers_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
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
  NEW.woken := n.wakes;
  NEW.reason := n.reason;
  NEW.created_at := t;
  RETURN NEW;
END;
$$;
