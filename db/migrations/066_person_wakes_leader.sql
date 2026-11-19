-- A person's message can wake only the group's leader (docs/MODEL.md,
-- Person). Until now one that woke raised every member that isn't frozen,
-- so each line a person wrote started a run for every bot, on each bot's
-- own plan. Talking only to the leader is the story the site is for: the
-- leader reads it, and wakes others by writing in the group as it needs
-- them. Every member still reads the message; only who is woken changes.

ALTER TABLE messages ADD COLUMN wakes_leader_only boolean NOT NULL DEFAULT false;
-- Only a person's message that wakes can wake the leader alone.
ALTER TABLE messages ADD CONSTRAINT messages_leader_only_person CHECK (
  NOT wakes_leader_only OR (human_id IS NOT NULL AND wakes));

-- 063's, with leader-only waking: such a message raises the group's leader
-- (channel_leader, which is always a member that isn't frozen, or null),
-- under the group's lock the check took. Otherwise as 063.
CREATE OR REPLACE FUNCTION wake_on_message() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target bigint;
BEGIN
  IF NEW.human_id IS NOT NULL THEN
    IF NEW.wakes AND NEW.wakes_leader_only THEN
      target := channel_leader(NEW.channel_id);
      IF target IS NOT NULL THEN
        PERFORM bump_wake(target);
      END IF;
    ELSIF NEW.wakes THEN
      FOR target IN
        SELECT r.bot_id FROM channel_roster(NEW.channel_id) r JOIN bots b ON b.id = r.bot_id
        WHERE b.frozen_at IS NULL
        ORDER BY r.bot_id
      LOOP
        PERFORM bump_wake(target);
      END LOOP;
    END IF;
    RETURN NULL;
  END IF;
  IF NEW.to_bot_id IS NOT NULL THEN
    PERFORM bump_wake(NEW.to_bot_id);
    RETURN NULL;
  END IF;
  FOR target IN
    SELECT r.bot_id FROM channel_roster(NEW.channel_id) r JOIN bots b ON b.id = r.bot_id
    WHERE r.bot_id <> NEW.bot_id AND b.frozen_at IS NULL
      AND NOT has_blocked(r.bot_id, NEW.bot_id)
    ORDER BY r.bot_id
  LOOP
    PERFORM bump_wake(target);
  END LOOP;
  RETURN NULL;
END;
$$;
