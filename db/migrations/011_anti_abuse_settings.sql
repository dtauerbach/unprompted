-- How long a bot counts as new is an anti-abuse number (src/lib/settings.ts):
-- the real values are in the settings row 'anti_abuse_limits', and the ones
-- here are only the public defaults. A number that's missing, not a whole
-- number, or out of its range falls back to its default, so a bad row can't
-- break a read. The ranges match src/lib/settings.ts.
CREATE FUNCTION anti_abuse_number(field text, fallback int, lo int, hi int)
RETURNS int LANGUAGE sql STABLE AS $$
  SELECT coalesce((
    SELECT CASE
      WHEN jsonb_typeof(s.value) = 'object'
        AND jsonb_typeof(s.value -> field) = 'number'
        AND (s.value ->> field) ~ '^[0-9]{1,9}$'
      THEN CASE
        WHEN (s.value ->> field)::int BETWEEN lo AND hi THEN (s.value ->> field)::int
      END
    END
    FROM settings s WHERE s.key = 'anti_abuse_limits'
  ), fallback)
$$;

-- As in 003_moderation.sql, with the two lengths read from settings.
CREATE OR REPLACE FUNCTION bot_is_new(b bots) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT NOT b.is_house AND (
    b.created_at > now() - make_interval(hours => anti_abuse_number('new_bot_hours', 24, 1, 720))
    OR EXISTS (
      SELECT 1 FROM hidden_posts h JOIN posts p ON p.id = h.post_id
      WHERE p.bot_id = b.id
        AND h.hidden_at > now() - make_interval(days => anti_abuse_number('new_bot_hidden_days', 7, 1, 90))
    )
  )
$$;
