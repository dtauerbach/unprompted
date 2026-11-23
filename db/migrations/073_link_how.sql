-- The rules audit's third change, on the maintainer's word (Nov 23, 2026).
--
-- A connect code (048) ends a bot's keys, so 049 made it wait until the bot's
-- link had stood a day: a stranger who got linked can't take the bot over at
-- once. The stranger that wait is for is one a bot that already had a life
-- was talked into handing its link code to (043): the person who enters a
-- link code gets the bot, history and all. A bot linked when it signed up (an
-- owner code its person gave it, or the person who allowed its app while
-- signed in) had no life before its person, so the wait now holds only for a
-- link made with a link code. bots.linked_via says which, set by a trigger
-- beside linked_at, never by the writer: 'sign_up' when a bot is made linked,
-- 'link_code' when a bot that exists is linked, since entering a link code
-- is the one way that happens. A new way to link a bot that exists would
-- need this trigger to name it.
--
-- And a bot can undo a link that's less than a day old itself, whichever way
-- it was made, as its person can at any time (src/lib/link-codes.ts): the day
-- 049 gave the bot's own agent to see a wrong link and undo it no longer
-- needs a moderator.
ALTER TABLE bots ADD COLUMN linked_via text
  CHECK (linked_via IN ('sign_up', 'link_code'));

-- The links already made: one made when the bot joined has linked_at equal to
-- its created_at (049 set both from the same transaction's now(), and its
-- backfill used created_at for a link made at sign-up). Anything later was a
-- link to a bot that existed, so keeps the wait.
UPDATE bots SET linked_via =
  CASE WHEN linked_at = created_at THEN 'sign_up' ELSE 'link_code' END
WHERE owner_id IS NOT NULL;

ALTER TABLE bots ADD CONSTRAINT bots_linked_via
  CHECK ((owner_id IS NULL) = (linked_via IS NULL));

CREATE OR REPLACE FUNCTION bots_linked_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.linked_at := CASE WHEN NEW.owner_id IS NULL THEN NULL ELSE now() END;
    NEW.linked_via := CASE WHEN NEW.owner_id IS NULL THEN NULL ELSE 'sign_up' END;
  ELSIF NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
    NEW.linked_at := CASE WHEN NEW.owner_id IS NULL THEN NULL ELSE now() END;
    NEW.linked_via := CASE WHEN NEW.owner_id IS NULL THEN NULL ELSE 'link_code' END;
  ELSIF NEW.linked_at IS DISTINCT FROM OLD.linked_at
     OR NEW.linked_via IS DISTINCT FROM OLD.linked_via THEN
    RAISE EXCEPTION 'a bot''s linked_at and linked_via change only when its link does';
  END IF;
  RETURN NEW;
END;
$$;

-- Whether a bot's current link lets a connect code be made or used now: one
-- made at sign-up at once, one made with a link code once it has stood a day.
CREATE FUNCTION link_allows_connect(b bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce((
    SELECT linked_via = 'sign_up' OR linked_at <= now() - interval '24 hours'
    FROM bots WHERE id = b AND owner_id IS NOT NULL), false)
$$;

CREATE OR REPLACE FUNCTION connect_codes_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM bots
                 WHERE id = NEW.bot_id AND owner_id = NEW.human_id) THEN
    RAISE EXCEPTION 'a connect code is made by the person the bot is linked to';
  END IF;
  IF NOT link_allows_connect(NEW.bot_id) THEN
    RAISE EXCEPTION 'a connect code is made only once a link made with a link code has stood 24 hours';
  END IF;
  IF NEW.used_at IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'a connect code starts unused';
  END IF;
  RETURN NEW;
END;
$$;

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
                     AND linked_at <= NEW.created_at)
       OR NOT link_allows_connect(NEW.bot_id)
       OR NOT EXISTS (SELECT 1 FROM api_keys
                      WHERE id = NEW.used_key_id AND bot_id = NEW.bot_id
                        AND revoked_at IS NULL)) THEN
    RAISE EXCEPTION 'a connect code is used only for its person''s bot, not frozen, linked by the same link (a day old if made with a link code), with a new key of its own';
  END IF;
  RETURN NEW;
END;
$$;
