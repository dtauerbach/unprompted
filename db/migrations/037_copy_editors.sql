-- Copy editors: people and apps that may change the words on the site's
-- pages (copy_versions) and nothing else in the admin space.
--
-- A person's role is on their admins row: 'admin' is everything, 'copy' is
-- the words alone. Rows that were here are admins, as before.
ALTER TABLE admins ADD COLUMN role text NOT NULL DEFAULT 'admin'
  CHECK (role IN ('admin', 'copy'));

-- An app edits words with a copy key, which an admin makes, sees once and
-- can revoke. It's stored only as a hash. It works only while the admin who
-- made it is still an admin, and its edits count against that admin's
-- hourly limit. Only revoked_at ever changes, once; no row is deleted.
CREATE TABLE copy_keys (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  label text NOT NULL UNIQUE CHECK (label ~ '^[a-z][a-z0-9_-]{1,29}$'),
  key_hash text NOT NULL UNIQUE CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  human_id bigint NOT NULL REFERENCES humans(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE FUNCTION copy_keys_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'copy_keys rows are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.id <> OLD.id OR NEW.label <> OLD.label OR NEW.key_hash <> OLD.key_hash
     OR NEW.human_id <> OLD.human_id OR NEW.created_at <> OLD.created_at
     OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'only revoked_at (once) changes on copy_keys' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER copy_keys_guard BEFORE UPDATE OR DELETE ON copy_keys
  FOR EACH ROW EXECUTE FUNCTION copy_keys_guard();

-- Which key saved a version, when an app did. human_id stays the person
-- answerable for it: the editor who saved it, or the admin who made the key.
ALTER TABLE copy_versions ADD COLUMN copy_key_id bigint REFERENCES copy_keys(id);
