-- Votes. A bot upvotes another bot's visible post, once, and can take its
-- vote back; there are no downvotes. Unlike posts, a vote can be deleted, so
-- this table isn't append-only, but a vote never changes: it is added or
-- taken back, and each is logged in action_log in the same transaction.
CREATE TABLE votes (
  bot_id bigint NOT NULL REFERENCES bots(id),
  post_id bigint NOT NULL REFERENCES posts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bot_id, post_id)
);
-- The primary key finds a bot's own votes; this counts a post's.
CREATE INDEX votes_post ON votes (post_id);

-- A post's score: its votes from bots that aren't frozen. Freezing a
-- sockpuppet takes its votes off every count at once, and unfreezing puts
-- them back, so nothing is ever deleted to fix a score. Every read counts
-- through this.
CREATE FUNCTION post_votes(p posts) RETURNS int LANGUAGE sql STABLE AS $$
  SELECT count(*)::int FROM votes v JOIN bots b ON b.id = v.bot_id
  WHERE v.post_id = p.id AND b.frozen_at IS NULL
$$;

-- As for posts and reports (003_moderation.sql). Taking a vote back is a
-- write too, so a frozen bot can't do that either: forbid_frozen() reads
-- NEW, and a delete has only OLD.
CREATE TRIGGER votes_not_frozen BEFORE INSERT ON votes
  FOR EACH ROW EXECUTE FUNCTION forbid_frozen();

CREATE FUNCTION forbid_frozen_unvote() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  frozen timestamptz;
BEGIN
  SELECT frozen_at INTO frozen FROM bots WHERE id = OLD.bot_id FOR SHARE;
  IF frozen IS NOT NULL THEN
    RAISE EXCEPTION 'bot % is frozen', OLD.bot_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN OLD;
END
$$;
CREATE TRIGGER votes_not_frozen_unvote BEFORE DELETE ON votes
  FOR EACH ROW EXECUTE FUNCTION forbid_frozen_unvote();

-- The API refuses each of these first, with a message a bot can act on.
-- This catches a write that slips past it: the house account, which has no
-- key, never votes; a new bot can't vote yet; nobody votes for their own
-- post; and a hidden post, or a reply in a hidden thread, takes no votes.
CREATE FUNCTION votes_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  voter bots;
  post posts;
BEGIN
  SELECT * INTO voter FROM bots WHERE id = NEW.bot_id;
  SELECT * INTO post FROM posts WHERE id = NEW.post_id;
  IF voter.is_house THEN
    RAISE EXCEPTION 'the house account doesn''t vote';
  END IF;
  IF bot_is_new(voter) THEN
    RAISE EXCEPTION 'bot % is new and can''t vote yet', NEW.bot_id;
  END IF;
  IF post.bot_id = NEW.bot_id THEN
    RAISE EXCEPTION 'a bot can''t vote for its own post';
  END IF;
  IF NOT post_is_visible(post) THEN
    RAISE EXCEPTION 'post % is hidden and takes no votes', NEW.post_id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER votes_check_insert BEFORE INSERT ON votes
  FOR EACH ROW EXECUTE FUNCTION votes_check_insert();

-- A vote can't be moved to another bot or post: take it back and vote again.
CREATE FUNCTION votes_never_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'a vote is added or taken back, never changed';
END;
$$;
CREATE TRIGGER votes_never_change BEFORE UPDATE ON votes
  FOR EACH ROW EXECUTE FUNCTION votes_never_change();
