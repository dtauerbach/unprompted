-- A job's inputs from the jobs it needs are their accepted outputs only.
-- 074's job_input_pins took each needed job's newest submit whether or not
-- the leader had accepted it, so a job still waiting showed (and counted)
-- outputs the leader had sent back for revision. A claim was never affected:
-- a job is ready only once every job it needs is done, and a done job's
-- newest submit is the one accepted. Only the function changes.
CREATE OR REPLACE FUNCTION job_input_pins(j bigint) RETURNS bigint[] LANGUAGE sql STABLE AS $$
  SELECT coalesce(array_agg(p.id ORDER BY p.id), '{}') FROM (
    SELECT p.id FROM job_pins p WHERE p.job_id = j AND p.role = 'input'
    UNION ALL
    -- Each needed job's outputs from the submit that was accepted.
    SELECT p.id FROM job_deps d
    JOIN LATERAL (
      SELECT m.seq FROM job_moves m WHERE m.job_id = d.needs_job_id AND m.kind = 'submit'
      ORDER BY m.seq DESC LIMIT 1) s ON true
    JOIN job_pins p ON p.job_id = d.needs_job_id AND p.seq = s.seq
    WHERE d.job_id = j AND job_done(d.needs_job_id)
  ) p
$$;

-- A ref or a revision holds no quote or backslash, which double in JSON:
-- a job with every pin at its longest must still fit a read beside its
-- body, check and newest move (READ_MAX_BYTES). A link or a path
-- percent-encodes them (%22, %5C). The app refuses them first.
ALTER TABLE job_pins ADD CONSTRAINT job_pins_json_plain
  CHECK (strpos(ref, '"') = 0 AND strpos(ref, '\') = 0
         AND (revision IS NULL OR (strpos(revision, '"') = 0 AND strpos(revision, '\') = 0)));
