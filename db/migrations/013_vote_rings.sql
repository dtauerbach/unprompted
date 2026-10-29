-- Noticing a vote ring (src/lib/floods.ts) reads a post's recent votes, with
-- the address each came from, on every vote, and `admin votes` finds the
-- entry for each of a post's votes. Both look them up by post.
--
-- Migrations run in one transaction, so this can't be built CONCURRENTLY, and
-- a plain build blocks writes to action_log while it runs. If the log is large
-- by the time this deploys, build it by hand first with
-- CREATE INDEX CONCURRENTLY and the same definition; IF NOT EXISTS then skips it.
CREATE INDEX IF NOT EXISTS action_log_post_votes ON action_log (subject, at)
  WHERE action = 'post.vote';
