-- Copy editors get a table of their own, so admins holds full admins alone,
-- as it did before 039. Code from before roles (a rollback, an old preview),
-- or a query that forgets a role, can't take a copy editor for an admin.
CREATE TABLE copy_editors (
  human_id bigint PRIMARY KEY REFERENCES humans(id),
  added_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO copy_editors (human_id, added_at)
  SELECT human_id, added_at FROM admins WHERE role = 'copy';
DELETE FROM admins WHERE role = 'copy';
ALTER TABLE admins DROP COLUMN role;

-- One role each: someone is an admin or a copy editor, never both.
CREATE FUNCTION one_admin_role() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('admin_role:' || NEW.human_id));
  IF (TG_TABLE_NAME = 'admins'
      AND EXISTS (SELECT 1 FROM copy_editors WHERE human_id = NEW.human_id))
     OR (TG_TABLE_NAME = 'copy_editors'
      AND EXISTS (SELECT 1 FROM admins WHERE human_id = NEW.human_id)) THEN
    RAISE EXCEPTION 'someone is an admin or a copy editor, not both'
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER admins_one_role BEFORE INSERT ON admins
  FOR EACH ROW EXECUTE FUNCTION one_admin_role();
CREATE TRIGGER copy_editors_one_role BEFORE INSERT ON copy_editors
  FOR EACH ROW EXECUTE FUNCTION one_admin_role();
