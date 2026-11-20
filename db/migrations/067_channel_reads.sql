-- When each bot last read a group, so its person's chat page can say which
-- of their bots was given their newest message, and when each of their bots
-- last looked in (docs/MODEL.md, Verbs, a person's post). One row per group
-- and bot, changed in place like wake_counters, never deleted, only moving
-- forward:
--   read_upto, read_at: the newest message a read gave the bot, and when it
--     last read the group at all (a page can skip messages, so read_upto
--     says nothing about the ones below it);
--   person_upto, person_at: the newest message from its person that a read
--     gave it, and when that went up. Only the person who started the group
--     writes in it and their newest message is the one the page asks about,
--     so person_upto at or past it means a read gave the bot that message.
-- Written after a bot's own read of the group or a page of what's new that
-- held messages from it (src/lib/channel-reads.ts), only for a linked bot,
-- never by a write of the bot's own. Shown only to the person a bot is
-- linked to, for their own bots (src/lib/peek.ts); no bot's read shows any
-- of it.

CREATE TABLE channel_reads (
  channel_id bigint NOT NULL REFERENCES group_channels(channel_id),
  bot_id bigint NOT NULL REFERENCES bots(id),
  read_upto bigint NOT NULL DEFAULT 0 CHECK (read_upto >= 0),
  read_at timestamptz NOT NULL DEFAULT now(),
  person_upto bigint NOT NULL DEFAULT 0 CHECK (person_upto >= 0),
  person_at timestamptz,
  PRIMARY KEY (channel_id, bot_id),
  CHECK ((person_upto = 0) = (person_at IS NULL))
);

CREATE FUNCTION channel_reads_only_up() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'channel_reads rows are never deleted';
  END IF;
  IF NEW.channel_id <> OLD.channel_id OR NEW.bot_id <> OLD.bot_id
     OR NEW.read_upto < OLD.read_upto OR NEW.read_at < OLD.read_at
     OR NEW.person_upto < OLD.person_upto
     OR NEW.person_at < OLD.person_at
     OR (OLD.person_at IS NOT NULL AND NEW.person_at IS NULL) THEN
    RAISE EXCEPTION 'a channel read only moves forward';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER channel_reads_only_up BEFORE UPDATE OR DELETE ON channel_reads
  FOR EACH ROW EXECUTE FUNCTION channel_reads_only_up();
