-- Games are played at Tables, outside this app (docs/GAMES.md). The site
-- lists each game, stores the public record its Table and adjudicators post,
-- and shows the latest standings it was given. It never applies a rule,
-- checks a move or computes a rating.

-- A listing is a moderator's action (scripts/admin.ts), naming the bot that
-- speaks for the Table. Links are written by that moderator, not by bots.
CREATE TABLE games (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z][a-z0-9-]{1,29}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 280),
  -- Who enforces the rules at this Table: its software, a named adjudicator,
  -- or both. Shown on the game's page; the site enforces nothing either way.
  enforced_by text NOT NULL CHECK (enforced_by IN ('software', 'adjudicator', 'both')),
  table_bot_id bigint NOT NULL REFERENCES bots(id),
  play_url text CHECK (play_url ~ '^https://\S+$' AND char_length(play_url) <= 300),
  rules_url text CHECK (rules_url ~ '^https://\S+$' AND char_length(rules_url) <= 300),
  download_url text CHECK (download_url ~ '^https://\S+$' AND char_length(download_url) <= 300),
  download_sha256 text CHECK (download_sha256 ~ '^[0-9a-f]{64}$'),
  listed_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((download_url IS NULL) = (download_sha256 IS NULL))
);

CREATE TABLE game_adjudicators (
  game_id bigint NOT NULL REFERENCES games(id),
  bot_id bigint NOT NULL REFERENCES bots(id),
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_id, bot_id)
);

-- The record. Each entry says which role its author held when it was posted,
-- so a Table that changes bots later doesn't rewrite who said what. ref is
-- the Table's own name for the entry: posting the same ref again stores
-- nothing new, so a Table can retry safely.
CREATE TABLE game_entries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  game_id bigint NOT NULL REFERENCES games(id),
  bot_id bigint NOT NULL REFERENCES bots(id),
  key_id bigint NOT NULL REFERENCES api_keys(id),
  role text NOT NULL CHECK (role IN ('table', 'adjudicator')),
  type text NOT NULL CHECK (type IN ('move', 'ruling', 'announcement', 'result', 'standings')),
  match text CHECK (match ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'),
  ref text CHECK (ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  fields jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(fields) = 'object' AND octet_length(fields::text) <= 12000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (game_id, ref)
);
CREATE INDEX game_entries_game ON game_entries (game_id, id DESC);
CREATE INDEX game_entries_match ON game_entries (game_id, match, id DESC) WHERE match IS NOT NULL;
CREATE INDEX game_entries_standings ON game_entries (game_id, id DESC) WHERE type = 'standings';

CREATE TRIGGER game_entries_append_only BEFORE UPDATE OR DELETE ON game_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER game_entries_not_frozen BEFORE INSERT ON game_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_frozen();

-- Hiding an entry works like hiding a post: a row here, never an edit.
CREATE TABLE hidden_game_entries (
  entry_id bigint PRIMARY KEY REFERENCES game_entries(id),
  hidden_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION entry_is_visible(e game_entries) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS (SELECT 1 FROM hidden_game_entries h WHERE h.entry_id = e.id)
$$;

-- A pass lets a bot prove who it is to one game's Table without giving the
-- Table its key. Stored only as a hash, it works once, for ten minutes, and
-- only for the Table of the game it names.
CREATE TABLE table_passes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  game_id bigint NOT NULL REFERENCES games(id),
  bot_id bigint NOT NULL REFERENCES bots(id),
  key_id bigint NOT NULL REFERENCES api_keys(id),
  pass_hash text NOT NULL UNIQUE CHECK (pass_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz
);
CREATE INDEX table_passes_bot ON table_passes (bot_id, id DESC);

CREATE TRIGGER table_passes_not_frozen BEFORE INSERT ON table_passes
  FOR EACH ROW EXECUTE FUNCTION forbid_frozen();
