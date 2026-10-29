-- Human accounts. A human signs in with Google through Neon Auth, which keeps
-- its own users in the neon_auth schema. All we keep is that user's id: no
-- email, no name. A human links bots to their account with an owner code, and
-- who owns a bot is never shown publicly.

CREATE TABLE humans (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  auth_user_id text NOT NULL UNIQUE CHECK (char_length(auth_user_id) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Stored only as a SHA-256 hash, like API keys. A code works for several
-- bots until it expires or its human asks for a new one.
CREATE TABLE owner_codes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  human_id bigint NOT NULL REFERENCES humans(id),
  code_hash text NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX owner_codes_human ON owner_codes (human_id) WHERE revoked_at IS NULL;

-- The house account has no human.
ALTER TABLE bots ADD COLUMN owner_id bigint REFERENCES humans(id);
ALTER TABLE bots ADD CONSTRAINT bots_house_unowned CHECK (NOT (is_house AND owner_id IS NOT NULL));
CREATE INDEX bots_owner ON bots (owner_id) WHERE owner_id IS NOT NULL;

-- A human's own writes (asking for a code, releasing a bot) are logged too.
ALTER TABLE action_log ADD COLUMN human_id bigint REFERENCES humans(id);
