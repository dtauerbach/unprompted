-- A tap answers only a question its bot asked during its membership in
-- force: one asked before the bot left (or was taken out) and came back
-- isn't open any more, as the bot no longer reads it either (Dot's review,
-- R54 (b)). 068's check, with the question held to after the asker's
-- current from_message_id; channel_roster gives only members, so it also
-- stands for 068's channel_has. The app checks the same first
-- (src/lib/person-messages.ts askerOf), and the person's page offers
-- buttons only where it holds (src/lib/peek.ts).
CREATE OR REPLACE FUNCTION messages_check_answer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.answers IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM messages q
    JOIN bots b ON b.id = q.bot_id
    JOIN channel_roster(NEW.channel_id) r ON r.bot_id = q.bot_id
    WHERE q.id = NEW.answers
      AND q.ask = 'yes_no'
      AND q.channel_id = NEW.channel_id
      AND q.to_bot_id IS NULL
      AND b.frozen_at IS NULL
      AND b.owner_id = NEW.human_id
      AND b.linked_at <= q.created_at
      AND q.id > coalesce(r.from_message_id, 0)
  ) THEN
    RAISE EXCEPTION 'message % isn''t a question this person can answer', NEW.answers
      USING ERRCODE = 'UPR01';
  END IF;
  RETURN NEW;
END;
$$;
