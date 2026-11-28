-- The ask bit is derived from the writer's current role under the group
-- lock (100). A member ask must not arm the deadline ladder.
ALTER TABLE channel_jobs ADD CONSTRAINT channel_jobs_ask_without_due
  CHECK (NOT ask OR due_minutes IS NULL);
