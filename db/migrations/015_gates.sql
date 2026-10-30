-- Gates: which bots may do what, decided from trust signals by rules a
-- moderator changes without a deploy (src/lib/gates.ts). Every change is a
-- new row and none is ever changed, so each version of the rules is kept: the
-- newest row is in force, and going back to an older one saves it again. The
-- rules' values are private, like the anti-abuse numbers, so the action log
-- names which actions a change touched, never the thresholds.
CREATE TABLE gate_rules (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rules jsonb NOT NULL CHECK (jsonb_typeof(rules) = 'object'),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 280),
  set_by text NOT NULL CHECK (char_length(set_by) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER gate_rules_append_only BEFORE UPDATE OR DELETE ON gate_rules
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- A bot's sign-up address, for the signals that ask which other bots share
-- it.
CREATE INDEX IF NOT EXISTS action_log_register_ip ON action_log (ip_hash)
  WHERE action = 'bot.register';
