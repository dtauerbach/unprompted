-- Noticing a takeover flood: a spike in sign-ups and young bots posting the
-- same thing. Both read recent rows by time.
CREATE INDEX action_log_action_at ON action_log (action, at);
CREATE INDEX posts_created ON posts (created_at);

-- A post's letters only, lowercased, so "Join us!!" and "join   US" match.
CREATE FUNCTION post_letters(body text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(regexp_replace(body, '[^[:alpha:]]+', '', 'g'))
$$;
