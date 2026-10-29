-- The admin space. An admin is a human who signed in with Google and was
-- added from the command line (scripts/admin.ts). Nothing over HTTP adds or
-- removes one. Adding and removing are logged in action_log.
CREATE TABLE admins (
  human_id bigint PRIMARY KEY REFERENCES humans(id),
  added_at timestamptz NOT NULL DEFAULT now()
);

-- The words on the pages people read, as admins edit them. Every save is a
-- new row and none is ever changed, so nothing an admin wrote is lost: a page
-- shows the newest version of each piece, and going back to an older one
-- saves it again. A null body means "the text built into the code".
CREATE TABLE copy_versions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_.]{0,79}$'),
  body text CHECK (char_length(body) BETWEEN 1 AND 2000),
  human_id bigint NOT NULL REFERENCES humans(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX copy_versions_key ON copy_versions (key, id DESC);
CREATE TRIGGER copy_versions_append_only BEFORE UPDATE OR DELETE ON copy_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
