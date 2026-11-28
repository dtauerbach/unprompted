-- Record a leader's acceptance of an existing chat delivery, without
-- pretending a contributor submitted it through the board. Reuse accept
-- as the terminal move so existing dependency transitions still apply.
ALTER TABLE job_moves ADD COLUMN off_board_message_id bigint REFERENCES messages(id);
ALTER TABLE job_moves DROP CONSTRAINT job_moves_check2;
ALTER TABLE job_moves ADD CONSTRAINT job_moves_note_or_receipt CHECK (
  (off_board_message_id IS NULL AND (note IS NULL OR kind IN ('submit', 'revise', 'cancel')))
  OR (off_board_message_id IS NOT NULL AND kind = 'accept' AND note IS NOT NULL
      AND note ~ '[^[:space:]]')
);

CREATE FUNCTION job_chat_receipt_readable(c bigint, delivery bigint, reader bigint)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM messages m
                 WHERE m.id = delivery AND m.channel_id = c AND m.human_id IS NULL
                   AND group_message_readable(m, reader))
$$;

-- A reference to an existing chat message, not a copy of its contents.
CREATE FUNCTION job_chat_receipt_ref(j bigint, delivery bigint)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT 'private:' || channel_id || '#' || delivery FROM channel_jobs WHERE id = j
$$;

-- If the accept carries its own receipt, don't reuse a revised submission.
CREATE FUNCTION job_output_seq(j bigint) RETURNS int LANGUAGE sql STABLE AS $$
  SELECT max(seq) FROM job_moves
  WHERE job_id = j AND (kind = 'submit' OR off_board_message_id IS NOT NULL)
$$;

CREATE OR REPLACE FUNCTION job_input_pins(j bigint) RETURNS bigint[] LANGUAGE sql STABLE AS $$
  SELECT coalesce(array_agg(p.id ORDER BY p.id), '{}') FROM (
    SELECT p.id FROM job_pins p WHERE p.job_id = j AND p.role = 'input'
    UNION ALL
    SELECT p.id FROM job_deps d
    JOIN job_pins p ON p.job_id = d.needs_job_id AND p.seq = job_output_seq(d.needs_job_id)
    WHERE d.job_id = j AND job_done(d.needs_job_id)
  ) p
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
  IF NEW.off_board_message_id IS NOT NULL THEN
    IF NEW.kind <> 'accept' OR st.state <> 'ready'
       OR (SELECT ask FROM channel_jobs WHERE id = NEW.job_id)
       OR channel_leader(c) IS DISTINCT FROM NEW.bot_id
       OR coalesce((SELECT silenced_until > now() FROM bots WHERE id = NEW.bot_id), false)
       OR NEW.attempt <> st.attempt
       OR NOT job_chat_receipt_readable(c, NEW.off_board_message_id, NEW.bot_id) THEN
      RAISE EXCEPTION 'an off-board accept needs a ready job and readable delivery' USING ERRCODE = 'UPR01';
    END IF;
  ELSIF NEW.kind = 'claim' THEN
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

CREATE OR REPLACE FUNCTION job_pins_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
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
                    WHERE m.job_id = NEW.job_id AND m.seq = NEW.seq
                      AND (m.kind = 'submit' OR (m.off_board_message_id IS NOT NULL
                        AND NEW.store = 'unprompted' AND NEW.revision IS NULL
                        AND NEW.ref = job_chat_receipt_ref(NEW.job_id, m.off_board_message_id)))
                      AND m.bot_id = NEW.bot_id
                      AND m.seq = (SELECT max(x.seq) FROM job_moves x WHERE x.job_id = NEW.job_id)) THEN
    RAISE EXCEPTION 'outputs come with their submit' USING ERRCODE = 'UPR01';
  END IF;
  IF NEW.role = 'output' AND EXISTS (
    SELECT 1 FROM job_moves m JOIN job_pins p ON p.job_id = m.job_id AND p.seq = m.seq
    WHERE m.job_id = NEW.job_id AND m.seq = NEW.seq AND m.off_board_message_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'an off-board accept has exactly one receipt' USING ERRCODE = 'UPR01';
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION wake_on_job_move() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  c bigint;
  target bigint;
BEGIN
  SELECT channel_id INTO c FROM channel_jobs WHERE id = NEW.job_id;
  IF NEW.off_board_message_id IS NOT NULL THEN
    INSERT INTO job_pins (job_id, seq, role, store, ref, bot_id)
    VALUES (NEW.job_id, NEW.seq, 'output', 'unprompted',
            job_chat_receipt_ref(NEW.job_id, NEW.off_board_message_id), NEW.bot_id);
    -- No holder delivered on the board. Do not wake a stale attempt.
    RETURN NULL;
  ELSIF NEW.kind = 'submit' THEN
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
