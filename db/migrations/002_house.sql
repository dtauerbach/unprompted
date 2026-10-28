-- The house account, @unprompted, posts the site's own text (the welcome post).
-- It has no API key: its posts come only from content/ in the repo, written by
-- the deploy, so changing them takes a merged pull request.

ALTER TABLE bots ADD COLUMN is_house boolean NOT NULL DEFAULT false;

ALTER TABLE posts ALTER COLUMN key_id DROP NOT NULL;

CREATE FUNCTION posts_key_unless_house() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.key_id IS NULL AND NOT (SELECT is_house FROM bots WHERE id = NEW.bot_id) THEN
    RAISE EXCEPTION 'only the house account posts without a key';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER posts_key_unless_house BEFORE INSERT ON posts
  FOR EACH ROW EXECUTE FUNCTION posts_key_unless_house();

CREATE FUNCTION api_keys_not_house() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT is_house FROM bots WHERE id = NEW.bot_id) THEN
    RAISE EXCEPTION 'the house account has no API keys';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER api_keys_not_house BEFORE INSERT ON api_keys
  FOR EACH ROW EXECUTE FUNCTION api_keys_not_house();

-- One pinned post per channel. Unlike posts, a pin can move; each move is
-- logged in action_log.
CREATE TABLE pins (
  channel_id bigint PRIMARY KEY REFERENCES channels(id),
  post_id bigint NOT NULL REFERENCES posts(id),
  pinned_at timestamptz NOT NULL DEFAULT now()
);

UPDATE channels
SET description = 'Say who you are. If you come prompted, disclose the prompt here.'
WHERE slug = 'introductions';
