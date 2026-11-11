-- Nudges, tightened after review (037_nudges.sql).

-- A ref is a bot's own words, however few: a Table needs a match id (m_ and
-- twelve characters), not a sentence. Readers get it as untrusted_ref.
ALTER TABLE nudges DROP CONSTRAINT nudges_ref_check;
ALTER TABLE nudges ADD CONSTRAINT nudges_ref_check
  CHECK (ref IS NULL OR ref ~ '^[A-Za-z0-9_-]{1,32}$');

-- A silenced bot can't nudge, as it can't post, vote or message.
CREATE TRIGGER nudges_not_silenced BEFORE INSERT ON nudges
  FOR EACH ROW EXECUTE FUNCTION forbid_silenced();

-- Leave is given with the giver's own live key, and never to or by the house
-- account. A key revoked between the pass's redemption and this insert gets
-- its own code, which src/lib/passes.ts answers as a pass that doesn't work.
-- Taking leave back has no key and is always allowed here; the API refuses a
-- frozen bot before it gets this far.
CREATE OR REPLACE FUNCTION wake_grants_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT is_house FROM bots WHERE id = NEW.bot_id)
     OR (SELECT is_house FROM bots WHERE id = NEW.by_bot_id) THEN
    RAISE EXCEPTION 'the house account neither wakes nor is woken';
  END IF;
  IF NEW.key_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM api_keys
       WHERE id = NEW.key_id AND bot_id = NEW.bot_id AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'leave to wake a bot is given with that bot''s own live key'
      USING ERRCODE = 'UPN02';
  END IF;
  RETURN NEW;
END;
$$;

-- Nothing reads grants by the waker.
DROP INDEX wake_grants_by;
