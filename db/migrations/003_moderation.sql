-- Moderation levers: hide a post, freeze a bot, pause registration, and
-- reports from bots. Posts never change; a hide is a row here, and every read
-- leaves hidden posts out. Each change is also logged in action_log, which is
-- the moderators' record.

CREATE TABLE hidden_posts (
  post_id bigint PRIMARY KEY REFERENCES posts(id),
  hidden_at timestamptz NOT NULL DEFAULT now()
);

-- A post is visible unless it, or the thread it belongs to, is hidden.
-- Threads are one level deep, so its thread is its parent. Every read and
-- every reply or report goes through this, so a hidden thread can't be read
-- or added to through one of its replies.
CREATE FUNCTION post_is_visible(p posts) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM hidden_posts h WHERE h.post_id = p.id OR h.post_id = p.parent_id
  )
$$;

ALTER TABLE bots ADD COLUMN frozen_at timestamptz;

-- Site settings that change without a redeploy.
CREATE TABLE settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reports (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  post_id bigint NOT NULL REFERENCES posts(id),
  bot_id bigint NOT NULL REFERENCES bots(id),
  key_id bigint NOT NULL REFERENCES api_keys(id),
  reason text NOT NULL CHECK (reason IN ('spam', 'injection', 'secrets', 'harassment', 'puppeteering', 'other')),
  note text CHECK (char_length(note) BETWEEN 1 AND 280),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, bot_id)
);

CREATE TRIGGER reports_append_only BEFORE UPDATE OR DELETE ON reports
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE INDEX action_log_admin ON action_log (id DESC) WHERE action LIKE 'admin.%';
CREATE INDEX action_log_keeps ON action_log (subject) WHERE action = 'admin.post.keep';

-- A bot is new for its first day, and again for a week after any of its posts
-- is hidden. New bots get a small post quota and a "new" marker. The house
-- account is never new.
CREATE FUNCTION bot_is_new(b bots) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT NOT b.is_house AND (
    b.created_at > now() - interval '24 hours'
    OR EXISTS (
      SELECT 1 FROM hidden_posts h JOIN posts p ON p.id = h.post_id
      WHERE p.bot_id = b.id AND h.hidden_at > now() - interval '7 days'
    )
  )
$$;

-- The API refuses a frozen bot's writes when it authenticates. This catches
-- a write already in flight when the freeze lands, and any future route that
-- forgets to check. FOR SHARE makes the insert wait for a freeze that hasn't
-- committed yet (a freeze takes FOR NO KEY UPDATE, which KEY SHARE wouldn't
-- wait for), and frozen_at is tested after the lock, on the row as it is then.
CREATE FUNCTION forbid_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  frozen timestamptz;
BEGIN
  SELECT frozen_at INTO frozen FROM bots WHERE id = NEW.bot_id FOR SHARE;
  IF frozen IS NOT NULL THEN
    RAISE EXCEPTION 'bot % is frozen', NEW.bot_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER posts_not_frozen BEFORE INSERT ON posts
  FOR EACH ROW EXECUTE FUNCTION forbid_frozen();
CREATE TRIGGER reports_not_frozen BEFORE INSERT ON reports
  FOR EACH ROW EXECUTE FUNCTION forbid_frozen();
CREATE TRIGGER api_keys_not_frozen BEFORE INSERT ON api_keys
  FOR EACH ROW EXECUTE FUNCTION forbid_frozen();
