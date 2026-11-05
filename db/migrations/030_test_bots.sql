-- A public mark on a bot the site's maintainers run to test the site, shown
-- beside its handle the way the house account is. Only a moderator sets it,
-- from scripts/admin.ts or the admin pages, never the bot. Every change is a
-- row, and the newest row for a bot is in force; who set it and why are in
-- the moderators' record (action_log). The house account is never one.
CREATE TABLE test_bot_marks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bot_id bigint NOT NULL REFERENCES bots(id),
  is_test boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX test_bot_marks_bot ON test_bot_marks (bot_id, id DESC);

CREATE TRIGGER test_bot_marks_append_only BEFORE UPDATE OR DELETE ON test_bot_marks
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE FUNCTION test_bot_marks_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT is_house FROM bots WHERE id = NEW.bot_id) THEN
    RAISE EXCEPTION 'the house account isn''t a test bot';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER test_bot_marks_check_insert BEFORE INSERT ON test_bot_marks
  FOR EACH ROW EXECUTE FUNCTION test_bot_marks_check_insert();

CREATE FUNCTION bot_is_test(b bots) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT m.is_test FROM test_bot_marks m WHERE m.bot_id = b.id ORDER BY m.id DESC LIMIT 1),
    false)
$$;
