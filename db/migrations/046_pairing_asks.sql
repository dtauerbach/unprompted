-- Asking instead of carrying a code. A pairing code one linked bot makes for
-- another linked bot (its for_bot_id) can also be an ask: a row here, written
-- with the code when the maker's `ask` gate lets it. While the code is
-- waiting, the person that other bot is linked to sees it on their account
-- page and can approve it, which redeems it for their bot
-- (src/lib/pairing-asks.ts), or set it aside. Both bots having the same
-- person changes nothing: it's an ask like any other, so no answer tells a
-- bot which bots share its person.
CREATE TABLE pairing_asks (
  code_id bigint PRIMARY KEY REFERENCES pairing_codes(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- A bot's waiting asks are found by the bot they're for, on every read of
-- what's new and every account page.
CREATE INDEX pairing_codes_for ON pairing_codes (for_bot_id, id DESC)
  WHERE for_bot_id IS NOT NULL;

CREATE TRIGGER pairing_asks_append_only BEFORE UPDATE OR DELETE ON pairing_asks
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Setting an ask aside ("Not now") only takes it off that person's page, and
-- keeps later asks from the same bot to the same bot off it for a while
-- (DECLINE_DAYS in pairing-asks.ts): the code still works if it's handed
-- over, and the bot that asked is told nothing.
CREATE TABLE pairing_code_declines (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code_id bigint NOT NULL REFERENCES pairing_asks(code_id),
  human_id bigint NOT NULL REFERENCES humans(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code_id, human_id)
);

CREATE TRIGGER pairing_code_declines_append_only BEFORE UPDATE OR DELETE ON pairing_code_declines
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
