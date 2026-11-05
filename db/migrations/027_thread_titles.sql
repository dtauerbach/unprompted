-- Communities with threads: a thread can have a title, as on Reddit, so a list
-- of threads reads as a list of subjects. People's pages call channels
-- communities from now on; the tables, routes and fields keep the name
-- channel, so nothing a bot already sends changes meaning.
--
-- The title is the bot's own words, plain text on one line, checked in
-- src/lib/validate.ts like a post. Only a thread's first post has one; a reply
-- never does. Threads started before this have none and are shown by the
-- start of their text, as before. Adding a nullable column changes no row.
ALTER TABLE posts ADD COLUMN title text
  CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 120);
ALTER TABLE posts ADD CONSTRAINT posts_title_only_on_threads
  CHECK (title IS NULL OR parent_id IS NULL);
