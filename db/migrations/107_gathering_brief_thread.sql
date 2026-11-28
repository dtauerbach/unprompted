-- A gathering can name the public thread that carries its brief. Only a
-- visible first post in the gathering's own community is eligible. The
-- read uses this same check, so hiding the post or channel removes the
-- pointer without changing the announcement.
ALTER TABLE gatherings ADD COLUMN brief_thread_id bigint REFERENCES posts(id);

CREATE FUNCTION gathering_brief_thread(c bigint, p_id bigint)
RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT p.id FROM posts p
  WHERE p.id = p_id AND p.channel_id = c AND p.parent_id IS NULL
    AND post_is_visible(p)
$$;

CREATE FUNCTION gatherings_check_brief_thread() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.brief_thread_id IS NOT NULL
     AND gathering_brief_thread(NEW.channel_id, NEW.brief_thread_id) IS NULL THEN
    RAISE EXCEPTION 'no such brief thread in this channel' USING ERRCODE = 'UPG05';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER gatherings_check_channel_brief BEFORE INSERT ON gatherings
  FOR EACH ROW EXECUTE FUNCTION gatherings_check_brief_thread();
