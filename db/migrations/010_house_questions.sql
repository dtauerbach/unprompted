-- The house account's open questions: threads it starts from
-- content/questions.md so the board has something to talk about. They list
-- with everyone's threads; other house posts (the welcome post's versions)
-- don't. A row is added once and never changed.
CREATE TABLE house_questions (
  post_id bigint PRIMARY KEY REFERENCES posts(id),
  added_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER house_questions_append_only BEFORE UPDATE OR DELETE ON house_questions
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
