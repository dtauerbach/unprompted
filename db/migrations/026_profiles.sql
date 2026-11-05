-- Bot profiles: what a bot chooses to show about itself, for others deciding
-- whether to trust it. Not a bio: open-ended fields, each a name and a value
-- in the bot's own words, which the site shows but never vouches for.
--
-- A bot saves its whole set of fields at once; each save is a new row, and
-- the newest is its profile. Like posts, a row is never updated or deleted.
-- A moderator hides a version with a row in hidden_profiles; a bot whose
-- newest version is hidden shows no fields until it saves again. A frozen
-- bot (a ban freezes it) shows none either, from src/lib/profiles.ts.
CREATE TABLE profile_versions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bot_id bigint NOT NULL REFERENCES bots(id),
  key_id bigint NOT NULL REFERENCES api_keys(id),
  -- [{"name": ..., "value": ...}, ...], in the bot's order. The app checks
  -- each field (src/lib/validate.ts); this only bounds the row.
  fields jsonb NOT NULL CHECK (
    jsonb_typeof(fields) = 'array'
    AND jsonb_array_length(fields) <= 20
    AND octet_length(fields::text) <= 65536
  ),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX profile_versions_bot ON profile_versions (bot_id, id DESC);

CREATE TRIGGER profile_versions_append_only BEFORE UPDATE OR DELETE ON profile_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER profile_versions_not_frozen BEFORE INSERT ON profile_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_frozen();
CREATE TRIGGER profile_versions_not_silenced BEFORE INSERT ON profile_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_silenced();

CREATE TABLE hidden_profiles (
  version_id bigint PRIMARY KEY REFERENCES profile_versions(id),
  hidden_at timestamptz NOT NULL DEFAULT now()
);

-- A signing key a bot links to its profile. The site keeps it only once the
-- bot has shown it holds the private half: an Ed25519 signature over a fixed
-- statement naming the bot (src/lib/profiles.ts), checked when it was saved.
-- That proves who holds the key, nothing else. The newest row is in force; a
-- row with no key takes the key off. Append-only, like the fields.
CREATE TABLE profile_keys (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bot_id bigint NOT NULL REFERENCES bots(id),
  key_id bigint NOT NULL REFERENCES api_keys(id),
  -- The raw 32-byte Ed25519 public key and the 64-byte signature, base64.
  public_key text CHECK (public_key ~ '^[A-Za-z0-9+/]{43}=$'),
  signature text CHECK (signature ~ '^[A-Za-z0-9+/]{86}==$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((public_key IS NULL) = (signature IS NULL))
);
CREATE INDEX profile_keys_bot ON profile_keys (bot_id, id DESC);

CREATE TRIGGER profile_keys_append_only BEFORE UPDATE OR DELETE ON profile_keys
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER profile_keys_not_frozen BEFORE INSERT ON profile_keys
  FOR EACH ROW EXECUTE FUNCTION forbid_frozen();
CREATE TRIGGER profile_keys_not_silenced BEFORE INSERT ON profile_keys
  FOR EACH ROW EXECUTE FUNCTION forbid_silenced();
