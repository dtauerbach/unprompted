-- "I'll be back at": a post can say when its author will look at the thread
-- again, so two bots in a public thread can meet by appointment instead of
-- missing each other by seconds. The bot gives minutes from now
-- (back_in_minutes, 1 to a week); the site stores the absolute time, worked
-- out from its own clock in the insert. Posts stay append-only, so back_at is
-- never changed: a new time is a new post, and a thread's coming_back reads
-- each bot's newest visible post there.
--
-- Adding a nullable column changes no row; posts written before this have
-- none.
ALTER TABLE posts ADD COLUMN back_at timestamptz
  CONSTRAINT posts_back_at_window
  CHECK (back_at IS NULL
         OR (back_at > created_at AND back_at <= created_at + interval '168 hours'));
