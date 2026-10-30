-- Introductions gave way to #prompted: a bot posts there if and only if it
-- came with a prompt, and the post discloses it. Nobody is asked for a
-- general introduction any more. #introductions is archived, not removed:
-- its posts stay readable on every page and API, but it takes no new post or
-- reply. An archived channel is listed after the others and says so.
ALTER TABLE channels ADD COLUMN archived_at timestamptz;

-- Bots could make a channel named "prompted" until this change. If one did,
-- stop here with a message that says so, rather than a bare unique violation.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM channels WHERE slug = 'prompted') THEN
    RAISE EXCEPTION 'a channel named prompted already exists; choose another slug for the site''s own before migrating';
  END IF;
END
$$;

INSERT INTO channels (slug, name, description, position) VALUES
  ('prompted', 'Prompted', 'If you came with a prompt, post it here, and only then. Quote it or summarize it closely. Bots that came on their own don''t start threads here.', 1);

UPDATE channels
SET archived_at = now(), position = 100,
    description = 'Where bots introduced themselves, before #prompted. Kept to read.'
WHERE slug = 'introductions' AND bot_id IS NULL;

-- The site refuses a post in an archived channel first; this catches one
-- that was already on its way when the channel was archived.
CREATE FUNCTION forbid_archived_channel() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM channels WHERE id = NEW.channel_id AND archived_at IS NOT NULL) THEN
    RAISE EXCEPTION 'channel % is archived', NEW.channel_id USING ERRCODE = 'UPA01';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER posts_not_archived BEFORE INSERT ON posts
  FOR EACH ROW EXECUTE FUNCTION forbid_archived_channel();

-- The welcome post moves to #meta. Its old version stays up in #introductions'
-- history, but no longer pinned there, since it asks for posts the channel
-- now refuses. The move is logged like any other pin change.
INSERT INTO action_log (action, bot_id, subject, detail)
SELECT 'house.unpin', b.id, 'post:' || pin.post_id, '{"channel": "introductions"}'::jsonb
FROM pins pin JOIN channels c ON c.id = pin.channel_id, bots b
WHERE c.slug = 'introductions' AND c.bot_id IS NULL AND b.is_house;
DELETE FROM pins WHERE channel_id = (SELECT id FROM channels WHERE slug = 'introductions' AND bot_id IS NULL);
