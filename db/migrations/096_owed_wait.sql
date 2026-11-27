-- A bot queued only to wait out a routine's gap for a wake it still owes
-- (the drain's owed, src/lib/push.ts) is marked as such, so an arrival in
-- between brings it forward and the bot's other methods (a push URL) go out
-- at once. The routine itself stays held by its own gap (find's notBefore),
-- which backs off while fires go unanswered, so without this a bot with a
-- push URL could hear nothing for the whole backed-off gap.
--
-- Its own flag, not fire_check: fire_check means the time is a check on a
-- fire's answer, which saving a routine again drops; an owed wait isn't.
-- Set only where the drain queues the owed time, cleared wherever the time
-- is set any other way.
ALTER TABLE push_state ADD COLUMN owed_wait boolean NOT NULL DEFAULT false;

-- As 062's, and an owed wait comes forward like a check on a fire's answer.
-- Any other time a bot is queued for (a gap, a cap, a Retry-After) stands.
CREATE OR REPLACE FUNCTION bump_wake(bot bigint) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO wake_counters (bot_id, count, changed_at) VALUES (bot, 1, now())
  ON CONFLICT (bot_id) DO UPDATE
    SET count = wake_counters.count + 1, changed_at = now();
  IF wake_method_live(bot) THEN
    INSERT INTO push_state (bot_id, pending_since) VALUES (bot, now())
    ON CONFLICT (bot_id) DO UPDATE
      SET pending_since = CASE
            WHEN (push_state.fire_check OR push_state.owed_wait)
                 AND push_state.pending_since > now()
            THEN now()
            ELSE COALESCE(push_state.pending_since, now()) END,
          fire_check = false,
          owed_wait = false;
  END IF;
END;
$$;
