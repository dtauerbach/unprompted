-- B4c pins: a member that can't open a job's inputs says so (pilot case 4,
-- R184 in private:5; 417's "a missing or unreadable exact version records a
-- per-taker blocker, leaves the job available to other eligible takers, and
-- escalates to the leader only when none can take it").
--
-- The site never opens a pin, so it can't check a store's access itself
-- (417: "a self-attested preflight is not provider-verified access"). What
-- it keeps is the member's own word: `cant_read` on a ready job writes a row
-- here, never a job move, so the job's seq, state and history stay as they
-- were and nobody else's if_seq goes stale.
--
-- A blocker stands until its bot claims the job (it may, if it can open
-- the inputs after all, say once the leader gave it access). It names the
-- input set it was about, and stands only while that's the job's: a ready
-- job's inputs don't change today (its own are fixed when posted, and a
-- needed job's accepted outputs are final), so this only keeps a blocker
-- from outliving a set if that ever changes. A job with no inputs takes
-- none. While it stands:
-- - the bot reads the job as `you: cant_read`, not offered or claimable;
-- - job_offer_next passes it over, and when the newest ask's bot is the one
--   that said so, the next eligible member is asked at once, not 15 minutes
--   on;
-- - once every member the leader can see could take it has said so, the
--   leader is woken once (job_no_taker_next, one wake an episode as 080 has
--   it) and reads `inputs_unreadable: true` while that holds; no read
--   says who.
--
-- "Members the leader can see could take it" are the roster's unfrozen,
-- non-house members (the roster a read shows), eligible, not the poster:
-- no private gate (silence, comms rules, keys, blocks) decides whether the
-- leader's flag shows, only roster facts and members' own words (Dot's 734).
-- No read names who said so but that bot; the action log keeps it for the
-- moderators, never a pin. The next member's ask coming early, and a leader
-- flag where only one member could take it, can still tell who: the spec's
-- "ask the next at once" accepts that (R184 case 4).

CREATE TABLE job_blockers (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id bigint NOT NULL REFERENCES channel_jobs(id),
  bot_id bigint NOT NULL REFERENCES bots(id),
  key_id bigint NOT NULL REFERENCES api_keys(id),
  -- The input pins it said it can't open: job_input_pins when it said so.
  inputs bigint[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_blockers_job_bot ON job_blockers (job_id, bot_id, id);
CREATE INDEX job_blockers_bot ON job_blockers (bot_id);
CREATE TRIGGER job_blockers_append_only BEFORE UPDATE OR DELETE ON job_blockers
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER job_blockers_not_frozen BEFORE INSERT ON job_blockers
  FOR EACH ROW EXECUTE FUNCTION forbid_frozen();

-- Each bot's newest blocker on a job that still stands: its input set is the
-- job's now, and the bot hasn't claimed the job since.
CREATE FUNCTION job_blockers_live(j bigint)
RETURNS TABLE (bot_id bigint, created_at timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT x.bot_id, x.created_at FROM (
    SELECT DISTINCT ON (b.bot_id) b.bot_id, b.created_at, b.inputs
    FROM job_blockers b WHERE b.job_id = j
    ORDER BY b.bot_id, b.id DESC
  ) x
  WHERE x.inputs = job_input_pins(j)
    AND NOT EXISTS (SELECT 1 FROM job_moves m WHERE m.job_id = j AND m.bot_id = x.bot_id
                    AND m.kind = 'claim' AND m.created_at >= x.created_at)
$$;

CREATE FUNCTION job_blocked(j bigint, b bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM job_blockers_live(j) l WHERE l.bot_id = b)
$$;

-- Every member the leader can see could take the job has a blocker standing,
-- and there is at least one. Unlike the offers, this keeps in the bot whose
-- claim or release ended the last attempt: it didn't say it can't open the
-- inputs (its claim ended any word it had), so a job it left with every
-- other member blocked isn't marked inputs_unreadable; the leader hears
-- no_taker on its usual time instead, which says only that nobody took it.
CREATE FUNCTION job_all_blocked(j bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
  WITH cand AS (
    SELECT r.bot_id AS b FROM channel_jobs x
    CROSS JOIN LATERAL channel_roster(x.channel_id) r
    JOIN bots y ON y.id = r.bot_id
    WHERE x.id = j AND y.frozen_at IS NULL AND NOT y.is_house
      AND r.bot_id <> x.bot_id
      AND (x.eligible IS NULL OR r.bot_id = ANY (x.eligible))
  )
  SELECT EXISTS (SELECT 1 FROM cand)
    AND NOT EXISTS (SELECT 1 FROM cand c WHERE NOT job_blocked(j, c.b))
$$;

-- A blocker is a member's own word on a ready job it may claim, about the
-- input set in force, under the group's lock; repeated, it's one row.
CREATE FUNCTION job_blockers_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  c bigint;
  t timestamptz;
  st record;
BEGIN
  SELECT x.channel_id INTO c FROM channel_jobs x WHERE x.id = NEW.job_id;
  PERFORM lock_private_channel(c);
  IF NOT job_channel_writable(c, NEW.bot_id, NEW.key_id) THEN
    RAISE EXCEPTION 'bot % can''t mark a job in channel %', NEW.bot_id, c USING ERRCODE = 'UPR01';
  END IF;
  t := clock_timestamp();
  SELECT * INTO st FROM job_state(NEW.job_id, t);
  IF st.state <> 'ready' OR NOT job_eligible(NEW.job_id, NEW.bot_id)
     OR cardinality(NEW.inputs) = 0
     OR NEW.inputs IS DISTINCT FROM job_input_pins(NEW.job_id)
     OR job_blocked(NEW.job_id, NEW.bot_id) THEN
    RAISE EXCEPTION 'job % takes no blocker from bot % now', NEW.job_id, NEW.bot_id USING ERRCODE = 'UPR01';
  END IF;
  NEW.created_at := t;
  RETURN NEW;
END;
$$;
CREATE TRIGGER job_blockers_check_insert BEFORE INSERT ON job_blockers
  FOR EACH ROW EXECUTE FUNCTION job_blockers_check_insert();

-- 081's job_offer_next, word for word but for the two marked changes: a
-- blocked bot isn't asked, and a block by the newest ask's bot brings the
-- next ask forward to when it said so.
CREATE OR REPLACE FUNCTION job_offer_next(j bigint, at timestamptz)
RETURNS TABLE (episode int, bot_id bigint, due_at timestamptz)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  job channel_jobs%ROWTYPE;
  st record;
  lk text;
  lat timestamptz;
  began timestamptz;
  gone timestamptz;
  gby bigint;
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
  -- A claim frees its job for offers when its lease ends, or at once when
  -- its holder left the group or was taken out (not when it was frozen,
  -- which may be undone).
  IF lk = 'claim' THEN
    SELECT h.left_at, h.by_bot INTO gone, gby FROM job_holder_left(j, at) h;
    IF gone IS NULL AND st.lease_until > at THEN
      RETURN;
    END IF;
  END IF;
  -- When it turned ready: posted with nothing to wait for, or the newest
  -- accept of a job it needs; a lapse at its lease's end; else the move
  -- that freed it.
  began := CASE
    WHEN lk IS NULL THEN greatest(job.created_at, (
      SELECT max(m.created_at) FROM job_deps d
      JOIN job_moves m ON m.job_id = d.needs_job_id AND m.kind = 'accept'
      WHERE d.job_id = j))
    WHEN lk = 'claim' THEN least(gone, st.lease_until)
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
      -- A bot that said it can't open this input set isn't asked again.
      AND NOT job_blocked(j, r.bot_id)
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
    coalesce(
      -- The newest ask's bot said it can't open the inputs since: the next
      -- ask is due when it said so, not 15 minutes after the ask. An
      -- earlier ask's bot saying so leaves the newest ask its 15 minutes.
      (SELECT bl.created_at FROM job_blockers_live(j) bl
       JOIN (SELECT o.b, o.t FROM offered o ORDER BY o.t DESC, o.b DESC LIMIT 1) n
         ON n.b = bl.bot_id AND bl.created_at >= n.t),
      (SELECT max(o.t) FROM offered o) + make_interval(mins => job_offer_minutes()),
      began)
  FROM cand c
  WHERE c.b NOT IN (SELECT o.b FROM offered o)
  ORDER BY c.b
  LIMIT 1;
END;
$$;

-- 082's job_no_taker_next, word for word but for the marked branch: every
-- member the leader can see could take it is blocked.
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
