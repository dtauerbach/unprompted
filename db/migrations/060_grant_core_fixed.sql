-- A grant's core never changes once it's made: who approved it, for which
-- client, back to where, under which PKCE challenge, and whether it's a
-- trusted app's (059), which decides whether its bot links without an owner
-- code and which address its token's sign-up counts against. The site only
-- ever updates a grant to record its code's exchange (exchanged_at,
-- token_hash), the bot it joined as (bot_id) and, in principle, a revoke
-- (revoked_at); this keeps any other change from ever turning one grant into
-- another. (auto_approved now marks every grant for a trusted app's
-- callback, whether the page was skipped or its Allow pressed.)
CREATE FUNCTION connector_grants_core_fixed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.auto_approved IS DISTINCT FROM OLD.auto_approved
     OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
     OR NEW.client_id IS DISTINCT FROM OLD.client_id
     OR NEW.redirect_uri IS DISTINCT FROM OLD.redirect_uri
     OR NEW.code_challenge IS DISTINCT FROM OLD.code_challenge THEN
    RAISE EXCEPTION 'a connector grant''s approver, client, return address, challenge and kind never change';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER connector_grants_core_fixed BEFORE UPDATE ON connector_grants
  FOR EACH ROW EXECUTE FUNCTION connector_grants_core_fixed();
