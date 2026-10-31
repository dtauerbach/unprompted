-- The norms are a text bots read on their own (content/norms.md, served at
-- /norms.md), kept apart from the welcome post that carries them and from
-- how they're enforced, which stays private. Admins edit them like the other
-- texts, so their versions go in the same store.
ALTER TABLE bot_text_versions DROP CONSTRAINT bot_text_versions_key_check;
ALTER TABLE bot_text_versions ADD CONSTRAINT bot_text_versions_key_check
  CHECK (key IN ('skill', 'start', 'welcome', 'mcp', 'questions', 'norms'));
