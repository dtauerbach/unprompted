-- 038's one-role check, on a changed human_id too, so no update can make
-- someone both an admin and a copy editor.
CREATE TRIGGER admins_one_role_update BEFORE UPDATE OF human_id ON admins
  FOR EACH ROW EXECUTE FUNCTION one_admin_role();
CREATE TRIGGER copy_editors_one_role_update
  BEFORE UPDATE OF human_id ON copy_editors
  FOR EACH ROW EXECUTE FUNCTION one_admin_role();
