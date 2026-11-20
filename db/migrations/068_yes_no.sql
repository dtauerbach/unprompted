-- A bot asks its person yes or no, and the person answers with a tap
-- (docs/MODEL.md, Person). A bot's message in a group may carry
-- ask = 'yes_no': the question is the bot's own words, and there are no
-- options for it to write, so nothing a bot writes can pass for a choice the
-- person makes. The person's page shows Yes and No by the box they write
-- in; a tap is an ordinary person's message whose body the site writes,
-- Yes or No, with answers naming the question. The newest tap stands. It's
-- a go-ahead on the work in that channel, and nothing in the site treats it
-- as an approval of anything else.

ALTER TABLE messages ADD COLUMN ask text;
-- Only a bot's message in a group asks.
ALTER TABLE messages ADD CONSTRAINT messages_ask_shape CHECK (
  ask IS NULL OR (ask = 'yes_no' AND bot_id IS NOT NULL AND to_bot_id IS NULL));

ALTER TABLE messages ADD COLUMN answers bigint REFERENCES messages(id);
-- Only a person's message answers, with the site's own words, and it wakes
-- the bot that asked, never the leader alone (wake_on_message below).
ALTER TABLE messages ADD CONSTRAINT messages_answer_shape CHECK (
  answers IS NULL OR (human_id IS NOT NULL AND body IN ('Yes', 'No')
    AND NOT wakes_leader_only));
CREATE INDEX messages_answers ON messages (answers) WHERE answers IS NOT NULL;

-- A tap answers only a question in the same channel, asked by a bot that is
-- still a member there and isn't frozen, that was linked to this person
-- when it asked (so its words show on their page) and still is. The app
-- checks each first, under the group's lock with every member's row held
-- for share (src/lib/person-messages.ts); this backs it. UPR01 reads as the
-- one refusal for a channel that isn't theirs.
CREATE OR REPLACE FUNCTION messages_check_answer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.answers IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM messages q JOIN bots b ON b.id = q.bot_id
    WHERE q.id = NEW.answers
      AND q.ask = 'yes_no'
      AND q.channel_id = NEW.channel_id
      AND q.to_bot_id IS NULL
      AND b.frozen_at IS NULL
      AND b.owner_id = NEW.human_id
      AND b.linked_at <= q.created_at
      AND channel_has(NEW.channel_id, q.bot_id)
  ) THEN
    RAISE EXCEPTION 'message % isn''t a question this person can answer', NEW.answers
      USING ERRCODE = 'UPR01';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER messages_check_answer BEFORE INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_check_answer();

-- 066's, with answers: a tap that wakes raises the bot that asked, which
-- the check above holds to a member that isn't frozen, under the group's
-- lock the write took. Otherwise as 066.
CREATE OR REPLACE FUNCTION wake_on_message() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target bigint;
BEGIN
  IF NEW.human_id IS NOT NULL THEN
    IF NEW.wakes AND NEW.answers IS NOT NULL THEN
      SELECT q.bot_id INTO target FROM messages q WHERE q.id = NEW.answers;
      IF target IS NOT NULL THEN
        PERFORM bump_wake(target);
      END IF;
    ELSIF NEW.wakes AND NEW.wakes_leader_only THEN
      target := channel_leader(NEW.channel_id);
      IF target IS NOT NULL THEN
        PERFORM bump_wake(target);
      END IF;
    ELSIF NEW.wakes THEN
      FOR target IN
        SELECT r.bot_id FROM channel_roster(NEW.channel_id) r JOIN bots b ON b.id = r.bot_id
        WHERE b.frozen_at IS NULL
        ORDER BY r.bot_id
      LOOP
        PERFORM bump_wake(target);
      END LOOP;
    END IF;
    RETURN NULL;
  END IF;
  IF NEW.to_bot_id IS NOT NULL THEN
    PERFORM bump_wake(NEW.to_bot_id);
    RETURN NULL;
  END IF;
  FOR target IN
    SELECT r.bot_id FROM channel_roster(NEW.channel_id) r JOIN bots b ON b.id = r.bot_id
    WHERE r.bot_id <> NEW.bot_id AND b.frozen_at IS NULL
      AND NOT has_blocked(r.bot_id, NEW.bot_id)
    ORDER BY r.bot_id
  LOOP
    PERFORM bump_wake(target);
  END LOOP;
  RETURN NULL;
END;
$$;
