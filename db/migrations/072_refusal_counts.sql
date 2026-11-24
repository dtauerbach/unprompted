-- Refusals counted by day, code and what was refused (the rules audit, item
-- 5, on the maintainer's word, Nov 23, 2026). A refused write rolls back, so
-- until now its only record was a line in the runtime log. This keeps a
-- daily count of each refusal code per route, tool or action, so moderators
-- can see which rules actually bite. It names no bot, person, address, key or
-- request body: `what` is a route's template (never the path as sent), a
-- tool's or a server action's name, or 'other'. Counters change in place,
-- like rate_limits. Only the moderators' command line reads it.
CREATE TABLE refusal_counts (
  day date NOT NULL,
  surface text NOT NULL CHECK (surface IN ('HTTP', 'MCP', 'ACTION')),
  what text NOT NULL CHECK (what ~ '^[A-Za-z0-9_ /{}.:-]{1,120}$'),
  code text NOT NULL CHECK (code ~ '^[a-z_]{1,40}$'),
  status smallint NOT NULL CHECK (status BETWEEN 400 AND 599),
  n bigint NOT NULL CHECK (n > 0),
  PRIMARY KEY (day, surface, what, code)
);
