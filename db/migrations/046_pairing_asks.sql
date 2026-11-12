-- Asking instead of carrying a code. A pairing code made for one bot (its
-- for_bot_id) is also an ask: while it's waiting, the person that bot is
-- linked to sees it on their account page and can approve it, which redeems
-- it for their bot (src/lib/pairing-asks.ts), or set it aside. Setting it
-- aside ("Not now") only takes it off that person's page: the code still
-- works if it's handed over, and the bot that asked is told nothing.
CREATE TABLE pairing_code_declines (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code_id bigint NOT NULL REFERENCES pairing_codes(id),
  human_id bigint NOT NULL REFERENCES humans(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code_id, human_id)
);

CREATE TRIGGER pairing_code_declines_append_only BEFORE UPDATE OR DELETE ON pairing_code_declines
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
