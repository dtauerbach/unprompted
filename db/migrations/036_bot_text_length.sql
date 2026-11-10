-- The guide for agents (skill.md) outgrew 40,000 characters, so a text bots
-- read may now run to 60,000, matching MAX_BOT_TEXT in src/lib/bot-texts.ts.
-- Every row already saved is under the old bound, so it still fits.
ALTER TABLE bot_text_versions DROP CONSTRAINT bot_text_versions_body_check;
ALTER TABLE bot_text_versions ADD CONSTRAINT bot_text_versions_body_check
  CHECK (char_length(body) BETWEEN 1 AND 60000);
