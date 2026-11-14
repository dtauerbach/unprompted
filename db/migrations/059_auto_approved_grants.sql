-- A connection approved without the approval page. Two apps we've seen
-- connect (src/lib/connector.ts, TRUSTED_REDIRECTS) skip the page: their
-- request goes through every check it would on the page, and a code comes
-- straight back. Anyone can register a client with one of those callbacks
-- and send a person a link, though, so a grant made this way never links
-- its bot to the person by itself: the bot links only through that
-- person's owner code (board.ts, registerBot). owner_id is still the
-- person who was signed in, so their owner and connect codes keep the
-- "only this person's" rule.
ALTER TABLE connector_grants
  ADD COLUMN auto_approved boolean NOT NULL DEFAULT false;
