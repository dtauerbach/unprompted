-- A person's channel-scoped consent to overdue-job notices. Message push
-- subscriptions remain separate. The newest choice retires the earlier one.
CREATE TABLE job_overdue_person_choices (
  id bigserial PRIMARY KEY,
  human_id bigint NOT NULL REFERENCES humans(id),
  channel_id bigint NOT NULL REFERENCES group_channels(channel_id),
  enabled boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_overdue_person_choice_latest
  ON job_overdue_person_choices (human_id, channel_id, id DESC);
CREATE TRIGGER job_overdue_person_choices_append_only
  BEFORE UPDATE OR DELETE ON job_overdue_person_choices
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE FUNCTION job_overdue_person_opted(h bigint, c bigint)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT x.enabled FROM job_overdue_person_choices x
    WHERE x.human_id = h AND x.channel_id = c ORDER BY x.id DESC LIMIT 1), false)
$$;

CREATE FUNCTION job_overdue_person_can_read(h bigint, c bigint)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM group_channels g WHERE g.channel_id = c AND g.human_id = h)
    AND private_channel_is_open(c) AND private_channel_is_visible(c)
    AND EXISTS (SELECT 1 FROM channel_roster(c) r JOIN bots b ON b.id = r.bot_id
                WHERE b.owner_id = h AND b.frozen_at IS NULL)
$$;

CREATE FUNCTION job_overdue_person_target(j bigint)
RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT g.human_id FROM channel_jobs x
  JOIN group_channels g ON g.channel_id = x.channel_id
  CROSS JOIN LATERAL job_state(x.id, now()) s
  WHERE x.id = j AND s.state IN ('ready', 'claimed', 'review')
    AND job_overdue_person_can_read(g.human_id, g.channel_id)
    AND job_overdue_person_opted(g.human_id, g.channel_id)
    AND EXISTS (SELECT 1 FROM bots b WHERE b.id = x.bot_id AND b.frozen_at IS NULL)
    AND EXISTS (SELECT 1 FROM person_push_secrets p WHERE p.human_id = g.human_id)
$$;

-- One bounded, durable delivery attempt stream per job; the ladder's
-- append-only rung record is written in the same transaction.
CREATE TABLE job_overdue_person_notices (
  job_id bigint PRIMARY KEY REFERENCES channel_jobs(id),
  human_id bigint NOT NULL REFERENCES humans(id),
  channel_id bigint NOT NULL REFERENCES group_channels(channel_id),
  next_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '1 day',
  finished_at timestamptz
);
CREATE INDEX job_overdue_person_notices_pending
  ON job_overdue_person_notices (next_at, job_id) WHERE finished_at IS NULL;
