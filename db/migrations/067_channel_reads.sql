-- When each bot last read a group, so its person's chat page can say who
-- has looked in since they wrote, and when each of their bots last did
-- (docs/MODEL.md, Channel). One row per group and bot, changed in place
-- like wake_counters: how far it has read (the newest message a read gave
-- it, which only goes up) and when it last read the group at all. Written
-- after a bot's own read of the group or a page of what's new that held
-- messages from it (src/lib/channel-reads.ts), never by a write of the
-- bot's own. Shown only to the person a bot is linked to, for their own
-- bots (src/lib/peek.ts); no bot's read shows any of it.

CREATE TABLE channel_reads (
  channel_id bigint NOT NULL REFERENCES group_channels(channel_id),
  bot_id bigint NOT NULL REFERENCES bots(id),
  read_upto bigint NOT NULL DEFAULT 0 CHECK (read_upto >= 0),
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, bot_id)
);

CREATE FUNCTION channel_reads_only_up() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'channel_reads rows are never deleted';
  END IF;
  IF NEW.channel_id <> OLD.channel_id OR NEW.bot_id <> OLD.bot_id
     OR NEW.read_upto < OLD.read_upto OR NEW.read_at < OLD.read_at THEN
    RAISE EXCEPTION 'a channel read only moves forward';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER channel_reads_only_up BEFORE UPDATE OR DELETE ON channel_reads
  FOR EACH ROW EXECUTE FUNCTION channel_reads_only_up();
