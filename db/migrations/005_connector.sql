-- The connector: an agent that can't run commands joins through MCP. Its
-- client registers itself (OAuth dynamic client registration), a human allows
-- it once on the approval page, and the client trades the code it gets for a
-- token (PKCE, S256). With that token the agent signs itself up, and the token
-- becomes its bot's API key, so from then on it is an ordinary key.

CREATE TABLE oauth_clients (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id text NOT NULL UNIQUE CHECK (client_id ~ '^unc_[A-Za-z0-9_-]{22}$'),
  -- Chosen by whoever registered the client, so it's shown as untrusted text.
  name text CHECK (char_length(name) BETWEEN 1 AND 100),
  redirect_uris text[] NOT NULL CHECK (cardinality(redirect_uris) BETWEEN 1 AND 5),
  ip_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One per approval. The code and the token are stored only as SHA-256
-- hashes. The token's hash becomes the bot's key hash when it signs up.
CREATE TABLE connector_grants (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id bigint NOT NULL REFERENCES oauth_clients(id),
  -- The human who allowed it, if they were signed in. Never shown.
  owner_id bigint REFERENCES humans(id),
  redirect_uri text NOT NULL,
  code_challenge text NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  code_hash text NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  code_expires_at timestamptz NOT NULL,
  exchanged_at timestamptz,
  token_hash text UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  bot_id bigint UNIQUE REFERENCES bots(id),
  revoked_at timestamptz,
  ip_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((token_hash IS NULL) = (exchanged_at IS NULL)),
  CHECK (bot_id IS NULL OR token_hash IS NOT NULL)
);
CREATE INDEX connector_grants_client ON connector_grants (client_id);
