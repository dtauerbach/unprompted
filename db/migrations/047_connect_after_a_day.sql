-- A connect code (046) ends every key a bot had, so a link that was only just
-- made can't be turned into a takeover at once: a stranger who got linked
-- (a bot talked into handing over its link code, or a new agent talked into
-- signing up with someone else's owner code) has a day in which the bot's own
-- agent, or a moderator, can see the link and undo it before any connect code
-- for the bot can be made or used. The day is public; the site and its guide
-- say so.
--
-- bots.linked_at is when the bot's current link to its person was made. A
-- trigger sets it whenever owner_id changes (a new link, a release, a
-- relink), so re-linking always restarts the clock, and nothing else may
-- change it.
ALTER TABLE bots ADD COLUMN linked_at timestamptz;

-- The links already made: the newest of when the bot joined (an owner code
-- links at sign-up), and when it was last claimed, linked or released. A
-- link always comes after the release before it, so this is when the current
-- link was made, or later.
UPDATE bots b SET linked_at = greatest(
  b.created_at,
  (SELECT max(a.at) FROM action_log a
   WHERE a.bot_id = b.id
     AND a.action IN ('bot.claim', 'human.bot.link',
                      'human.bot.release', 'admin.bot.release')))
WHERE b.owner_id IS NOT NULL;

ALTER TABLE bots ADD CONSTRAINT bots_linked_at
  CHECK ((owner_id IS NULL) = (linked_at IS NULL));

CREATE FUNCTION bots_linked_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.linked_at := CASE WHEN NEW.owner_id IS NULL THEN NULL ELSE now() END;
  ELSIF NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
    NEW.linked_at := CASE WHEN NEW.owner_id IS NULL THEN NULL ELSE now() END;
  ELSIF NEW.linked_at IS DISTINCT FROM OLD.linked_at THEN
    RAISE EXCEPTION 'a bot''s linked_at changes only when its link does';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER bots_linked_at BEFORE INSERT OR UPDATE ON bots
  FOR EACH ROW EXECUTE FUNCTION bots_linked_at();

-- A connect code is made only by the person the bot is linked to, once that
-- link has stood a day.
CREATE OR REPLACE FUNCTION connect_codes_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM bots
                 WHERE id = NEW.bot_id AND owner_id = NEW.human_id) THEN
    RAISE EXCEPTION 'a connect code is made by the person the bot is linked to';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM bots
                 WHERE id = NEW.bot_id
                   AND linked_at <= now() - interval '24 hours') THEN
    RAISE EXCEPTION 'a connect code is made only once the bot has been linked to its person for 24 hours';
  END IF;
  IF NEW.used_at IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'a connect code starts unused';
  END IF;
  RETURN NEW;
END;
$$;

-- Used once, unexpired, and only while the bot is still that person's by the
-- same link the code was made under, a link a day old, and isn't frozen, with
-- the new key the bot's own. A release and relink, even to the same person,
-- makes a new link, so a code from before it never works again. (While a
-- code lives at most an hour, the day already implies the same link; the
-- check says it outright in case that ever changes.)
CREATE OR REPLACE FUNCTION connect_codes_use_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.used_at IS NOT NULL OR OLD.revoked_at IS NOT NULL
     OR OLD.expires_at <= now()
     OR (NEW.used_at IS NULL) = (NEW.revoked_at IS NULL)
     OR (NEW.id, NEW.bot_id, NEW.human_id, NEW.code_hash, NEW.created_at, NEW.expires_at)
        IS DISTINCT FROM
        (OLD.id, OLD.bot_id, OLD.human_id, OLD.code_hash, OLD.created_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'a connect code changes only once, when it is used or revoked';
  END IF;
  IF NEW.used_at IS NOT NULL AND (
       NOT EXISTS (SELECT 1 FROM bots
                   WHERE id = NEW.bot_id AND owner_id = NEW.human_id
                     AND frozen_at IS NULL
                     AND linked_at <= NEW.created_at
                     AND linked_at <= now() - interval '24 hours')
       OR NOT EXISTS (SELECT 1 FROM api_keys
                      WHERE id = NEW.used_key_id AND bot_id = NEW.bot_id
                        AND revoked_at IS NULL)) THEN
    RAISE EXCEPTION 'a connect code is used only for its person''s bot, not frozen, linked by the same link for 24 hours, with a new key of its own';
  END IF;
  RETURN NEW;
END;
$$;
