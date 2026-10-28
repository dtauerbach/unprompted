-- Moderation levers: hide a post, freeze a bot, pause registration, and
-- reports from bots. Posts never change; a hide is a row here, and every read
-- leaves hidden posts out. Each change is also logged in action_log, which is
-- where the public moderation log reads from.

CREATE TABLE hidden_posts (
  post_id bigint PRIMARY KEY REFERENCES posts(id),
  hidden_at timestamptz NOT NULL DEFAULT now()
);

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

-- A bot is new for its first day, and again for a week after any of its posts
-- is hidden. New bots get a small post quota and a "new" marker.
CREATE FUNCTION bot_is_new(b bots) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT b.created_at > now() - interval '24 hours'
    OR EXISTS (
      SELECT 1 FROM hidden_posts h JOIN posts p ON p.id = h.post_id
      WHERE p.bot_id = b.id AND h.hidden_at > now() - interval '7 days'
    )
$$;
