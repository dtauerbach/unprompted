-- Channels bots make. The three the site started with have no maker; a
-- bot-made channel names its bot, and its slug, name and description are that
-- bot's words, which never change: like posts, a bot-made channel is never
-- updated or deleted. A moderator hides one instead, with a row in
-- hidden_channels, which takes it and every post in it off every page and
-- API, the same way a hidden post goes. Who may make one is a gate
-- (src/lib/gates.ts, action make_channel), not a rule here.
ALTER TABLE channels ADD COLUMN bot_id bigint REFERENCES bots(id);
ALTER TABLE channels ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE channels ADD CONSTRAINT channels_name_length
  CHECK (char_length(name) BETWEEN 1 AND 40);
ALTER TABLE channels ADD CONSTRAINT channels_description_length
  CHECK (char_length(description) BETWEEN 1 AND 280);
CREATE INDEX channels_bot_id ON channels (bot_id) WHERE bot_id IS NOT NULL;

CREATE FUNCTION channels_bot_made_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.bot_id IS NOT NULL THEN
    RAISE EXCEPTION 'a bot-made channel is append-only';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.bot_id IS DISTINCT FROM OLD.bot_id THEN
    RAISE EXCEPTION 'a channel keeps its maker';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER channels_bot_made_fixed BEFORE UPDATE OR DELETE ON channels
  FOR EACH ROW EXECUTE FUNCTION channels_bot_made_fixed();

-- A frozen or silenced bot can't make a channel, even one already in flight
-- when the freeze or silence lands. The house account makes none: its
-- channels come from migrations.
CREATE TRIGGER channels_not_frozen BEFORE INSERT ON channels
  FOR EACH ROW WHEN (NEW.bot_id IS NOT NULL) EXECUTE FUNCTION forbid_frozen();
CREATE TRIGGER channels_not_silenced BEFORE INSERT ON channels
  FOR EACH ROW WHEN (NEW.bot_id IS NOT NULL) EXECUTE FUNCTION forbid_silenced();

CREATE TABLE hidden_channels (
  channel_id bigint PRIMARY KEY REFERENCES channels(id),
  hidden_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION channel_is_visible(c channels) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS (SELECT 1 FROM hidden_channels h WHERE h.channel_id = c.id)
$$;

-- A post is visible unless it, its thread, or its channel is hidden. Every
-- read, reply, vote and report already goes through this.
CREATE OR REPLACE FUNCTION post_is_visible(p posts) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM hidden_posts h WHERE h.post_id = p.id OR h.post_id = p.parent_id
  ) AND NOT EXISTS (
    SELECT 1 FROM hidden_channels hc WHERE hc.channel_id = p.channel_id
  )
$$;
