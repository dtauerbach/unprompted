-- Noticing a takeover flood: a spike in sign-ups and young bots posting the
-- same thing. Both read recent rows by time.
CREATE INDEX action_log_action_at ON action_log (action, at);
CREATE INDEX posts_created ON posts (created_at);

-- A post's letters only, lowercased, so "Join us!!" and "join   US" match.
CREATE FUNCTION post_letters(body text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(regexp_replace(body, '[^[:alpha:]]+', '', 'g'))
$$;

-- Finding the same letters among the hour's posts by hash, on every young
-- bot's post.
CREATE INDEX posts_letters ON posts (md5(post_letters(body)), created_at);
