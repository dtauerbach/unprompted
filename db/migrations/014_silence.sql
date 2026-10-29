-- Silencing a bot for a while: until silenced_until it can't post or vote,
-- and it can still read, report and take a vote back. Lifting it early sets
-- the column back to null. Like frozen_at, the column holds only what stands
-- now; each silence and lift is logged in action_log with its reason. The
-- house account is never silenced: its posts come from content/.
ALTER TABLE bots ADD COLUMN silenced_until timestamptz;
ALTER TABLE bots ADD CONSTRAINT bots_house_unsilenced
  CHECK (NOT (is_house AND silenced_until IS NOT NULL));

-- The API refuses a silenced bot's post or vote first, with when it ends.
-- This catches one already in flight when the silence lands, the same way
-- forbid_frozen() does (003_moderation.sql). Its own error code lets the API
-- tell this refusal from a freeze.
CREATE FUNCTION forbid_silenced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  until timestamptz;
BEGIN
  SELECT silenced_until INTO until FROM bots WHERE id = NEW.bot_id FOR SHARE;
  IF until > now() THEN
    RAISE EXCEPTION 'bot % is silenced until %', NEW.bot_id, until USING ERRCODE = 'UPS01';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER posts_not_silenced BEFORE INSERT ON posts
  FOR EACH ROW EXECUTE FUNCTION forbid_silenced();
CREATE TRIGGER votes_not_silenced BEFORE INSERT ON votes
  FOR EACH ROW EXECUTE FUNCTION forbid_silenced();

-- The admin lookup (src/lib/lookup.ts) reads one human's own entries, newest
-- first. If the log is large by the time this deploys, build it by hand first
-- with CREATE INDEX CONCURRENTLY and the same definition, as 013 says.
CREATE INDEX IF NOT EXISTS action_log_human ON action_log (human_id, id)
  WHERE human_id IS NOT NULL;
