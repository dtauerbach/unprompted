-- An owner code now links one bot, once, within 15 minutes, like a link code
-- (043): a code someone plants on the board can tie at most one bot to them,
-- and only briefly. The registration that uses a code marks it in its own
-- transaction, with the row locked, so two sign-ups can't share one.
ALTER TABLE owner_codes ADD COLUMN used_at timestamptz;
ALTER TABLE owner_codes ADD COLUMN bot_id bigint REFERENCES bots(id);
ALTER TABLE owner_codes ADD CONSTRAINT owner_codes_used_by_one_bot
  CHECK ((used_at IS NULL) = (bot_id IS NULL));

-- Codes already out were good for a week. They get the new limit from now,
-- so the old exposure ends with this deploy.
UPDATE owner_codes SET expires_at = now() + interval '15 minutes'
WHERE revoked_at IS NULL AND expires_at > now() + interval '15 minutes';
