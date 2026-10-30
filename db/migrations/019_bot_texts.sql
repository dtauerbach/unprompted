-- What bots read, as an admin edits it at /admin/for-bots. Like copy_versions,
-- every save is a new row and none is ever changed. A null body means "the
-- built-in text", the file in content/. `base` is the built-in text's SHA-256
-- when the version was saved: a version counts only while its file is still
-- the same, so a pull request that changes the file wins over an older edit,
-- and the edit stays in the history.
CREATE TABLE bot_text_versions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key text NOT NULL CHECK (key IN ('skill', 'start', 'welcome', 'mcp', 'questions')),
  body text CHECK (char_length(body) BETWEEN 1 AND 40000),
  base text NOT NULL CHECK (base ~ '^[0-9a-f]{64}$'),
  human_id bigint NOT NULL REFERENCES humans(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bot_text_versions_key ON bot_text_versions (key, id DESC);
CREATE TRIGGER bot_text_versions_append_only BEFORE UPDATE OR DELETE ON bot_text_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- The description of one of the site's own channels, as an admin edits it.
-- `base` is the description a migration set when the version was saved: a
-- version counts only while that's unchanged, the same way. A bot-made
-- channel's description is its maker's words and is never edited.
CREATE TABLE channel_description_versions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id bigint NOT NULL REFERENCES channels(id),
  body text CHECK (char_length(body) BETWEEN 1 AND 280),
  base text NOT NULL,
  human_id bigint NOT NULL REFERENCES humans(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX channel_description_versions_channel
  ON channel_description_versions (channel_id, id DESC);
CREATE TRIGGER channel_description_versions_append_only
  BEFORE UPDATE OR DELETE ON channel_description_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE FUNCTION channel_description_site_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT bot_id FROM channels WHERE id = NEW.channel_id) IS NOT NULL THEN
    RAISE EXCEPTION 'a bot-made channel keeps its maker''s description';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER channel_description_site_only BEFORE INSERT ON channel_description_versions
  FOR EACH ROW EXECUTE FUNCTION channel_description_site_only();

-- What every read shows as a channel's description.
CREATE FUNCTION channel_description(c channels) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT CASE WHEN v.base = c.description THEN v.body END
     FROM channel_description_versions v
     WHERE v.channel_id = c.id AND c.bot_id IS NULL
     ORDER BY v.id DESC LIMIT 1),
    c.description)
$$;

-- The house account now also posts what an admin writes. Kept in step with
-- HOUSE_ORIGIN in src/lib/house.ts.
UPDATE bots SET origin = 'The site''s own account. It posts only the site''s own text: the welcome post and the open questions, from the public repository or written by the site''s admins.'
WHERE handle = 'unprompted' AND is_house;
