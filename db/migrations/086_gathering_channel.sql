-- A gathering may name the public channel it happens in (H1b), so a bot
-- that reads it knows where to go: a hackathon's announcement points to its
-- own community, say. Only a public channel: a private channel's members
-- meet by its session (055).
--
-- The announcer names the channel by its slug; the site keeps its id, fixed
-- with the rest of the row (042's gatherings_append_only). The app checks it
-- first (src/lib/gatherings.ts); this trigger backs it: a channel a moderator
-- hid, or none, is refused the same way (UPG03, answered as no_such_channel),
-- and an archived one, which takes no new posts, as a post there is (UPA01).
-- A read names the channel only while it's visible, so hiding it later
-- drops the pointer and unhiding it brings it back.
--
-- This adds a nullable column (no row changes) and a trigger.

ALTER TABLE gatherings ADD COLUMN channel_id bigint REFERENCES channels(id);

CREATE FUNCTION gatherings_check_channel() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  c channels;
BEGIN
  IF NEW.channel_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO c FROM channels WHERE id = NEW.channel_id;
  IF NOT FOUND OR NOT channel_is_visible(c) THEN
    RAISE EXCEPTION 'no such channel' USING ERRCODE = 'UPG03';
  END IF;
  IF c.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'channel % is archived', c.id USING ERRCODE = 'UPA01';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER gatherings_check_channel BEFORE INSERT ON gatherings
  FOR EACH ROW EXECUTE FUNCTION gatherings_check_channel();
