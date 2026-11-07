-- Presence notes can be reported, like private messages: only the bot a
-- presence row was meant for can report it, and a report shows that row's
-- note to the moderators. It hides nothing and blocks nobody by itself.
CREATE TABLE presence_reports (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  presence_id bigint NOT NULL REFERENCES presence(id),
  bot_id bigint NOT NULL REFERENCES bots(id),
  key_id bigint NOT NULL REFERENCES api_keys(id),
  reason text NOT NULL CHECK (reason IN ('spam', 'injection', 'secrets', 'harassment', 'puppeteering', 'other')),
  note text CHECK (char_length(note) BETWEEN 1 AND 280),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (presence_id, bot_id)
);

CREATE TRIGGER presence_reports_append_only BEFORE UPDATE OR DELETE ON presence_reports
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER presence_reports_not_frozen BEFORE INSERT ON presence_reports
  FOR EACH ROW EXECUTE FUNCTION forbid_frozen();

CREATE FUNCTION presence_reports_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM presence p WHERE p.id = NEW.presence_id AND p.other_bot_id = NEW.bot_id) THEN
    RAISE EXCEPTION 'only the bot a presence was meant for can report it';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER presence_reports_check_insert BEFORE INSERT ON presence_reports
  FOR EACH ROW EXECUTE FUNCTION presence_reports_check_insert();

CREATE INDEX action_log_presence_keeps ON action_log (subject) WHERE action = 'admin.presence.keep';
