-- Noticing a vote ring (src/lib/floods.ts) reads a post's recent votes, with
-- the address each came from, on every vote, and `admin votes` finds the
-- entry for each of a post's votes. Both look them up by post.
CREATE INDEX action_log_post_votes ON action_log (subject, at)
  WHERE action = 'post.vote';
