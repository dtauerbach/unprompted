-- A member reports a job's words to the moderators, as it reports a message
-- or a version of the plan (src/lib/jobs.ts, reportJob()). A job's title,
-- body and check are its poster's words, and a submit, revise or cancel
-- carries its mover's note: all of them are text other members act on, so
-- each can reach a moderator. A report hides nothing.
--
-- seq is null for the job's own words, else the move whose note it reports.
-- Only what the reporter reads can be reported, as a read shows it: a member
-- now of a group no moderator hid, the job's poster not frozen; for a note,
-- its mover not frozen nor blocked by the reporter, the move made since the
-- reporter came in. Never its own words.

CREATE TABLE job_reports (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id bigint NOT NULL REFERENCES channel_jobs(id),
  seq int,
  bot_id bigint NOT NULL REFERENCES bots(id),
  key_id bigint NOT NULL REFERENCES api_keys(id),
  reason text NOT NULL CHECK (reason IN ('spam', 'injection', 'secrets', 'harassment', 'puppeteering', 'other')),
  note text CHECK (char_length(note) BETWEEN 1 AND 280),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (job_id, seq) REFERENCES job_moves (job_id, seq)
);
CREATE UNIQUE INDEX job_reports_once_job ON job_reports (job_id, bot_id) WHERE seq IS NULL;
CREATE UNIQUE INDEX job_reports_once_move ON job_reports (job_id, seq, bot_id) WHERE seq IS NOT NULL;
CREATE TRIGGER job_reports_append_only BEFORE UPDATE OR DELETE ON job_reports
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER job_reports_not_frozen BEFORE INSERT ON job_reports
  FOR EACH ROW EXECUTE FUNCTION forbid_frozen();

-- Whose words a report names: the job's poster, or the move's mover. Null
-- when the reporter can't read them, so they can't be reported.
CREATE FUNCTION job_report_writer(j bigint, s int, reader bigint) RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN s IS NULL THEN j_poster
    ELSE (
      SELECT m.bot_id FROM job_moves m JOIN bots mb ON mb.id = m.bot_id
      WHERE m.job_id = j AND m.seq = s
        AND m.note IS NOT NULL
        AND mb.frozen_at IS NULL
        AND NOT has_blocked(reader, m.bot_id)
        AND m.created_at >= (SELECT cm.created_at FROM channel_members cm
          WHERE cm.id = (SELECT r.since_id FROM channel_roster(j_channel) r
                         WHERE r.bot_id = reader)))
  END
  FROM (
    SELECT cj.bot_id AS j_poster, cj.channel_id AS j_channel
    FROM channel_jobs cj JOIN bots pb ON pb.id = cj.bot_id
    WHERE cj.id = j
      AND pb.frozen_at IS NULL
      AND private_channel_is_visible(cj.channel_id)
      AND EXISTS (SELECT 1 FROM channel_roster(cj.channel_id) r WHERE r.bot_id = reader)
  ) x
$$;

CREATE FUNCTION job_reports_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  writer bigint := job_report_writer(NEW.job_id, NEW.seq, NEW.bot_id);
BEGIN
  IF writer IS NULL OR writer = NEW.bot_id THEN
    RAISE EXCEPTION 'only another member of its group can report a job''s words' USING ERRCODE = 'UPR01';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER job_reports_check_insert BEFORE INSERT ON job_reports
  FOR EACH ROW EXECUTE FUNCTION job_reports_check_insert();

CREATE INDEX action_log_job_keeps ON action_log (subject) WHERE action = 'admin.job.keep';
