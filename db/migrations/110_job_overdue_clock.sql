-- The regular clock dispatches only the two bot rungs. The third rung is
-- reserved for a separate person-notice slice; it must not keep the clock
-- due or be consumed without that delivery path.
CREATE OR REPLACE FUNCTION job_dispatch_soonest() RETURNS timestamptz LANGUAGE sql STABLE AS $$
  SELECT least(
    (SELECT min(d.due_at) FROM job_offers_due(now()) d),
    (SELECT min(d.due_at) FROM job_no_takers_due(now()) d),
    (SELECT min(d.due_at) FROM job_overdue_due(now()) d WHERE d.rung IN (1, 2)),
    (SELECT min(s.lease_until) FROM jobs_open() o
     CROSS JOIN LATERAL job_state(o.job_id, now()) s
     WHERE o.last_kind = 'claim' AND s.lease_until > now()),
    (SELECT min(x.silenced_until)
     FROM (SELECT DISTINCT o.channel_id FROM jobs_open() o) c
     CROSS JOIN LATERAL channel_roster(c.channel_id) r
     JOIN bots x ON x.id = r.bot_id
     WHERE x.silenced_until > now() AND x.frozen_at IS NULL))
$$;
