-- Claude routines (061_claude_fire.sql), after review. 061 may already have
-- run on a preview's branch, so the changes are their own migration rather
-- than an edit to it.

-- A fire whose request went out but whose answer never came (a timeout or a
-- reset after the request was written) may have started a run: it's kept
-- as 'maybe', waited on like a delivered fire, and never fired again at the
-- gap. A person's test fire is marked as one: it's evidence, but it never
-- counts toward a wake's answer.
ALTER TABLE fire_attempts DROP CONSTRAINT fire_attempts_outcome_check;
ALTER TABLE fire_attempts ADD CONSTRAINT fire_attempts_outcome_check
  CHECK (outcome IN
    ('delivered', 'maybe', 'http_error', 'timeout', 'network', 'unanswered'));
ALTER TABLE fire_attempts ADD COLUMN test boolean NOT NULL DEFAULT false;

-- The attempt number counts earlier tries at one wake under one routine.
-- Nothing is pruned yet: one row a send, bounded by the gap, the daily cap
-- and the person's hourly limit on test fires. Pruning old rows waits until
-- the table's size calls for it.
CREATE INDEX fire_attempts_wake ON fire_attempts (bot_id, trigger_id, wake);

-- Still append-only but for one change: a delivered fire, or one that maybe
-- went, that the bot didn't answer in time is marked unanswered, once, in
-- place. A test fire never is.
CREATE OR REPLACE FUNCTION fire_attempts_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.outcome IN ('delivered', 'maybe')
     AND NEW.outcome = 'unanswered' AND NOT OLD.test AND NOT NEW.test
     AND NEW.id = OLD.id AND NEW.bot_id = OLD.bot_id
     AND NEW.trigger_id = OLD.trigger_id AND NEW.wake = OLD.wake
     AND NEW.attempt = OLD.attempt AND NEW.sent_at = OLD.sent_at
     AND NEW.finished_at = OLD.finished_at
     AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.retry_after IS NOT DISTINCT FROM OLD.retry_after
     AND NEW.excerpt IS NOT DISTINCT FROM OLD.excerpt THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'fire_attempts is append-only, but for marking a delivered fire unanswered';
END;
$$;

-- gone_answers, gone_since: 401 and 404 answers in a row, and when the
-- first came. One alone may be a passing fault at the API, so the routine
-- ends only after a few, an hour apart at least.
-- open_fires, open_since: fires (delivered or maybe) since the bot last
-- read its number, whatever wake each carried, and when the first went;
-- enough of them, unanswered past the wait, mark the routine once.
-- capped_at: when the daily cap last held a fire back, logged once a day.
ALTER TABLE fire_state
  ADD COLUMN gone_answers int NOT NULL DEFAULT 0 CHECK (gone_answers >= 0),
  ADD COLUMN gone_since timestamptz,
  ADD COLUMN open_fires int NOT NULL DEFAULT 0 CHECK (open_fires >= 0),
  ADD COLUMN open_since timestamptz,
  ADD COLUMN capped_at timestamptz;

-- Whether the bot's queued time (pending_since) is only a check on a fire's
-- answer, set beside it by the fire's record() and cleared whenever the
-- time is set any other way. Replaces 061's comparison of pending_since
-- with fire_state.ack_due_at, which held only to the microsecond.
ALTER TABLE push_state ADD COLUMN fire_check boolean NOT NULL DEFAULT false;

-- An arrival while the bot waits only on a fire's answer is something new,
-- to be fired once the gap is over: it brings that check forward to now,
-- and the drain's own gap (find's notBefore) holds it from there. Any other
-- time a bot is queued for (a gap, a cap, a Retry-After) stands.
CREATE OR REPLACE FUNCTION bump_wake(bot bigint) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO wake_counters (bot_id, count, changed_at) VALUES (bot, 1, now())
  ON CONFLICT (bot_id) DO UPDATE
    SET count = wake_counters.count + 1, changed_at = now();
  IF wake_method_live(bot) THEN
    INSERT INTO push_state (bot_id, pending_since) VALUES (bot, now())
    ON CONFLICT (bot_id) DO UPDATE
      SET pending_since = CASE
            WHEN push_state.fire_check AND push_state.pending_since > now()
            THEN now()
            ELSE COALESCE(push_state.pending_since, now()) END,
          fire_check = false;
  END IF;
END;
$$;
