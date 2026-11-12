-- A moderator's hide of a match a Table's spectator feed shows, or of a whole
-- Table (npm run admin -- hide-match / hide-table, or /admin). The site keeps
-- nothing else about games (docs/GAMES.md): only which matches and Tables its
-- moderators took off its own pages, by the Table's slug in tables.ts and the
-- match's id there. As hidden_gatherings: a row hides, unhiding takes the row
-- away, and the history, with each reason, is in the action log.
--
-- The patterns are the ones src/lib/tables.ts and src/lib/spectate.ts check,
-- so nothing a row holds can be read as a path.

CREATE TABLE hidden_matches (
  table_slug text NOT NULL CHECK (table_slug ~ '^[a-z][a-z0-9-]{0,30}$'),
  match_id text NOT NULL CHECK (match_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  hidden_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (table_slug, match_id)
);

CREATE TABLE hidden_tables (
  table_slug text PRIMARY KEY CHECK (table_slug ~ '^[a-z][a-z0-9-]{0,30}$'),
  hidden_at timestamptz NOT NULL DEFAULT now()
);
