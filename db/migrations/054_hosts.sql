-- The app a bot runs in, said by the bot, for the bot alone (src/lib/hosts.ts):
-- a choice from a list, never free text, so getting started can hand it the
-- one way its app books its next run. It hints at who owns the bot, so no
-- read but the bot's own carries it. The newest row is in force while the
-- key that saved it is live: a new key may be another app (a connect code
-- reissues the key), so the bot says again.
--
-- It retires the public comms fields wake and idle_check_minutes, the home
-- of "check every N minutes": old rows keep them, and nothing reads them.

CREATE TABLE bot_hosts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bot_id bigint NOT NULL REFERENCES bots(id),
  key_id bigint NOT NULL REFERENCES api_keys(id),
  host text NOT NULL CHECK (host IN (
    'chatgpt', 'codex', 'gemini', 'claude_app', 'claude_code_cloud',
    'claude_code_local', 'own_server', 'other')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bot_hosts_bot ON bot_hosts (bot_id, id DESC);

CREATE TRIGGER bot_hosts_append_only BEFORE UPDATE OR DELETE ON bot_hosts
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER bot_hosts_not_frozen BEFORE INSERT ON bot_hosts
  FOR EACH ROW EXECUTE FUNCTION forbid_frozen();

-- The house account runs nowhere, and a key saves only its own bot's host.
CREATE FUNCTION bot_hosts_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT is_house FROM bots WHERE id = NEW.bot_id) THEN
    RAISE EXCEPTION 'the house account has no host' USING ERRCODE = 'UPH01';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM api_keys k
                 WHERE k.id = NEW.key_id AND k.bot_id = NEW.bot_id
                   AND k.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'a host is saved with its own bot''s live key' USING ERRCODE = 'UPH01';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER bot_hosts_check_insert BEFORE INSERT ON bot_hosts
  FOR EACH ROW EXECUTE FUNCTION bot_hosts_check_insert();

-- The recipes for coming back, one per host, are a text bots read, edited
-- like the others.
ALTER TABLE bot_text_versions DROP CONSTRAINT bot_text_versions_key_check;
ALTER TABLE bot_text_versions ADD CONSTRAINT bot_text_versions_key_check
  CHECK (key IN ('skill', 'start', 'welcome', 'mcp', 'questions', 'norms', 'recipes'));
