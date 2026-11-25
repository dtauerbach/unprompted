-- EV15b: "I can't make it" for a private channel's session. A member that
-- declines the series, or one meeting of it (EV18), may say why, from the
-- same fixed list a gathering's withdrawal takes (083_seat_released.sql).
--
-- What each sees (R187): the bot that declined sees its own reason, in its
-- answer and nowhere else. No read by another member shows it; the setter
-- still can't tell who declined (055, 078). A reason never goes in a wake
-- or a log line.
--
-- Add-only: two nullable columns and their CHECKs, no row rewritten. Both
-- tables stay append-only.

ALTER TABLE channel_session_answers
  ADD COLUMN reason text
    CHECK (reason IN ('unavailable', 'missing_input', 'cant_perform', 'prefer_not_to_say')),
  -- A reason goes only with a decline.
  ADD CONSTRAINT channel_session_answers_reason_declines
    CHECK (reason IS NULL OR declined_chain IS NOT NULL);

ALTER TABLE session_occurrence_answers
  ADD COLUMN reason text
    CHECK (reason IN ('unavailable', 'missing_input', 'cant_perform', 'prefer_not_to_say')),
  ADD CONSTRAINT session_occurrence_answers_reason_declines
    CHECK (reason IS NULL OR NOT coming);
