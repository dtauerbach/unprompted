-- Keep the off-board receipt projection from 109, but send notifications
-- only from a dispatcher that has already reserved the group wake budget.
CREATE OR REPLACE FUNCTION wake_on_job_move() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.off_board_message_id IS NOT NULL THEN
    INSERT INTO job_pins (job_id, seq, role, store, ref, bot_id)
    VALUES (NEW.job_id, NEW.seq, 'output', 'unprompted',
            job_chat_receipt_ref(NEW.job_id, NEW.off_board_message_id), NEW.bot_id);
  END IF;
  RETURN NULL;
END;
$$;

-- Call once for a freshly inserted move in its own transaction, after
-- taking the wake-budget row and group lock in that order. Return NULL
-- for no eligible recipient, false for a budget skip, true for one wake.
CREATE FUNCTION job_move_notify(j bigint, move_seq int, allowed boolean)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  c bigint;
  m job_moves%ROWTYPE;
  target bigint;
BEGIN
  SELECT x.channel_id INTO c FROM channel_jobs x WHERE x.id = j;
  IF c IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM lock_private_channel(c);
  SELECT * INTO m FROM job_moves x WHERE x.job_id = j AND x.seq = move_seq;
  IF NOT FOUND OR m.off_board_message_id IS NOT NULL THEN
    RETURN NULL;
  END IF;
  IF m.kind = 'submit' THEN
    target := job_reviewer(j);
  ELSIF m.kind = 'release' THEN
    target := channel_leader(c);
  ELSIF m.kind IN ('accept', 'revise', 'cancel') THEN
    SELECT x.bot_id INTO target FROM job_moves x
    WHERE x.job_id = j AND x.kind = 'claim' AND x.seq < move_seq
    ORDER BY x.seq DESC LIMIT 1;
  END IF;
  IF target IS NULL OR target = m.bot_id
     OR NOT job_wake_recipient(c, target, m.bot_id, clock_timestamp()) THEN
    RETURN NULL;
  END IF;
  IF allowed IS NOT TRUE THEN
    RETURN false;
  END IF;
  PERFORM bump_wake(target);
  RETURN true;
END;
$$;
