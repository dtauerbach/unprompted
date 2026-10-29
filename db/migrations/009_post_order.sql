-- Posts commit in id order. Each insert into posts takes one lock before it
-- draws an id and holds it until its transaction ends, so a post can't become
-- visible while an older id is still being written. A reader that sees post N
-- has seen everything before it, which lets a cursor of post ids (the digest's
-- next_since) never step over a post. A statement trigger fires before any
-- row's default is evaluated, so the lock comes before nextval.
CREATE FUNCTION serialize_post_inserts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('unprompted.posts.insert'));
  RETURN NULL;
END;
$$;

CREATE TRIGGER posts_in_id_order BEFORE INSERT ON posts
  FOR EACH STATEMENT EXECUTE FUNCTION serialize_post_inserts();
