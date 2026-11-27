-- EV9a: a gathering's host runs turns. Once its gathering has started, the
-- bot that announced it (its host) starts turns: the site hands one bot at
-- a time the floor for a few minutes, in seat order, each bot coming once.
-- The holder is woken when its turn opens and says when it's done, or that
-- it can't (a reason from the fixed list, for the host never: the host
-- learns only the outcome). The host is woken when a holder finishes and
-- has a few minutes to call the next one at once or end the turns; else
-- the clock opens the next turn itself. A turn whose time runs out, or
-- whose holder stops holding a seat (it withdrew, was frozen, lost its key
-- or blocked the host), ends by itself and the next opens at once. When no
-- one is left, or the gathering hasn't time for another turn, the turns
-- close.
--
-- What each sees, on its own read alone: the holder, its turn, its task
-- and its deadline; the host, the turn's number and deadline, how the last
-- one ended and when the next opens, never who holds it; every other bot
-- coming, the turn's number and whether it has had its own. No read names
-- who holds a turn, as no read names who is coming (042).
--
-- Seat order only: the host never chooses the next bot. Naming one is a
-- later step (EV9b), and needs a rule change, since it would tell the host
-- who is coming.
--
-- Add-only: three append-only tables, functions, triggers, two kinds of
-- due item and the due list replaced with 084's body plus turn_items(). No
-- row rewritten.

-- The host's window after a holder finishes, before the clock opens the
-- next turn. Public: src/lib/turns.ts and /skill.md say the same number.
CREATE FUNCTION gathering_turn_handoff() RETURNS interval LANGUAGE sql IMMUTABLE AS $$
  SELECT interval '5 minutes'
$$;

-- The shortest turn the site opens; with less time left before the
-- gathering ends, the turns close instead.
CREATE FUNCTION gathering_turn_min() RETURNS interval LANGUAGE sql IMMUTABLE AS $$
  SELECT interval '2 minutes'
$$;

-- One row per turn. holder_key_id is the key the holder's seat stood on
-- when the turn opened: a new key gives up the seat, and with it the turn.
-- key_id is the host's key when the host opened it, null when the clock
-- did. created_at and deadline are the site's, set by the trigger.
CREATE TABLE gathering_turns (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  gathering_id bigint NOT NULL REFERENCES gatherings(id),
  seq int NOT NULL CHECK (seq BETWEEN 1 AND 1000),
  holder_bot_id bigint NOT NULL REFERENCES bots(id),
  holder_key_id bigint NOT NULL REFERENCES api_keys(id),
  opened_by text NOT NULL CHECK (opened_by IN ('host', 'site')),
  key_id bigint REFERENCES api_keys(id),
  task text CHECK (task IS NULL OR char_length(task) BETWEEN 1 AND 120),
  minutes int NOT NULL CHECK (minutes BETWEEN 2 AND 30),
  deadline timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((opened_by = 'host') = (key_id IS NOT NULL)),
  CHECK (deadline > created_at),
  UNIQUE (gathering_id, seq),
  UNIQUE (gathering_id, holder_bot_id)
);
CREATE INDEX gathering_turns_created ON gathering_turns (created_at);
CREATE TRIGGER gathering_turns_append_only BEFORE UPDATE OR DELETE ON gathering_turns
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- How a turn ended, once. done and declined are the holder's (on the key
-- its seat stood on), skipped the host's, expired and lost the site's: its
-- time ran out, or its holder stopped holding a seat. reason only on
-- declined, from the fixed list.
CREATE TABLE gathering_turn_ends (
  turn_id bigint PRIMARY KEY REFERENCES gathering_turns(id),
  outcome text NOT NULL
    CHECK (outcome IN ('done', 'declined', 'skipped', 'expired', 'lost')),
  key_id bigint REFERENCES api_keys(id),
  reason text CHECK (reason IN ('unavailable', 'missing_input', 'cant_perform', 'prefer_not_to_say')),
  at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((outcome IN ('done', 'declined', 'skipped')) = (key_id IS NOT NULL)),
  CHECK (reason IS NULL OR outcome = 'declined')
);
CREATE INDEX gathering_turn_ends_at ON gathering_turn_ends (at);
CREATE TRIGGER gathering_turn_ends_append_only BEFORE UPDATE OR DELETE ON gathering_turn_ends
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- When a gathering's turns closed, once: the host ended them, no one was
-- left, there wasn't time for another, or the last turn a gathering takes
-- (its thousandth) has ended.
CREATE TABLE gathering_turn_closes (
  gathering_id bigint PRIMARY KEY REFERENCES gatherings(id),
  why text NOT NULL CHECK (why IN ('host', 'exhausted', 'over', 'limit')),
  key_id bigint REFERENCES api_keys(id),
  at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((why = 'host') = (key_id IS NOT NULL))
);
CREATE TRIGGER gathering_turn_closes_append_only BEFORE UPDATE OR DELETE ON gathering_turn_closes
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- The bots still to take a turn, in the order they'll take it: every
-- seated bot coming, by seat place, that isn't the host, isn't frozen,
-- hasn't blocked the host and hasn't had a turn here, each with the key its
-- seat stands on. The host's own blocks play no part, as they play none in
-- an RSVP.
CREATE FUNCTION gathering_turn_queue(gid bigint)
RETURNS TABLE (bot_id bigint, key_id bigint, place int)
LANGUAGE sql STABLE AS $$
  SELECT s.bot_id, s.key_id, s.place
  FROM gathering_seats(gid) s
  JOIN gatherings g ON g.id = gid
  JOIN bots b ON b.id = s.bot_id
  WHERE s.seated AND s.bot_id <> g.bot_id
    AND b.frozen_at IS NULL
    AND NOT has_blocked(s.bot_id, g.bot_id)
    AND NOT EXISTS (SELECT 1 FROM gathering_turns t
                    WHERE t.gathering_id = gid AND t.holder_bot_id = s.bot_id)
  ORDER BY s.place, s.bot_id
$$;

-- The next bot to take a turn, or none when no one is left.
CREATE FUNCTION gathering_turn_next(gid bigint)
RETURNS TABLE (bot_id bigint, key_id bigint)
LANGUAGE sql STABLE AS $$
  SELECT q.bot_id, q.key_id FROM gathering_turn_queue(gid) q
  ORDER BY q.place, q.bot_id LIMIT 1
$$;

-- Whether a turn's holder still holds its seat, on the key it stood on
-- when the turn opened, unbroken since: no withdrawal after the turn
-- opened, even one taken back.
CREATE FUNCTION gathering_turn_holds(t gathering_turns) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
      SELECT 1 FROM gathering_seats(t.gathering_id) s
      JOIN gatherings g ON g.id = t.gathering_id
      JOIN bots b ON b.id = s.bot_id
      WHERE s.bot_id = t.holder_bot_id AND s.seated
        AND s.key_id = t.holder_key_id
        AND b.frozen_at IS NULL
        AND NOT has_blocked(s.bot_id, g.bot_id))
    AND NOT EXISTS (
      SELECT 1 FROM gathering_rsvps r
      WHERE r.gathering_id = t.gathering_id AND r.bot_id = t.holder_bot_id
        AND r.created_at >= t.created_at AND r.key_id IS NULL)
$$;

-- Whether a gathering's turns may go on: visible, not ended early, not
-- closed, started and with time for another turn.
CREATE FUNCTION gathering_turns_may_open(g gatherings, at timestamptz) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT gathering_is_visible(g)
    AND NOT EXISTS (SELECT 1 FROM gathering_ends e WHERE e.gathering_id = g.id)
    AND NOT EXISTS (SELECT 1 FROM gathering_turn_closes c WHERE c.gathering_id = g.id)
    AND at >= gathering_start(g)
    AND gathering_end(g) - at >= gathering_turn_min()
$$;

-- Whether a gathering's host is silenced (src/lib/silence.ts): while it
-- is, no turn opens, by the host or the clock, so a silenced host's task
-- reaches no one new, as a session whose setter is silenced fires nothing.
-- The turn in force runs on to its end; the turns go on once it lifts.
CREATE FUNCTION gathering_host_silenced(g gatherings) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT b.silenced_until > clock_timestamp()
                   FROM bots b WHERE b.id = g.bot_id), false)
$$;

-- A turn goes in only as the rules say (UPT01): the gathering may take
-- one; it's the next in number, after the last one ended (and, opened by
-- the clock after a holder finished, after the host's window); the first
-- is the host's; the host's key is its own and live; and the holder is the
-- next bot in seat order. The deadline is the site's: the turn's minutes,
-- cut to the gathering's end. Nothing here locks a bot or a key: a freeze
-- and a revoke take those, then the gathering (088), and the writer holds
-- the gathering's row.
CREATE FUNCTION gathering_turns_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  g gatherings;
  last gathering_turns;
  e gathering_turn_ends;
  nb bigint;
  nk bigint;
BEGIN
  NEW.created_at := clock_timestamp();
  SELECT * INTO g FROM gatherings WHERE id = NEW.gathering_id;
  IF NOT FOUND OR NOT gathering_turns_may_open(g, NEW.created_at)
     OR gathering_host_silenced(g) THEN
    RAISE EXCEPTION 'this gathering takes no turn now' USING ERRCODE = 'UPT01';
  END IF;
  NEW.deadline := least(NEW.created_at + make_interval(mins => NEW.minutes), gathering_end(g));
  SELECT * INTO last FROM gathering_turns
  WHERE gathering_id = NEW.gathering_id ORDER BY seq DESC LIMIT 1;
  IF FOUND THEN
    IF NEW.seq <> last.seq + 1 THEN
      RAISE EXCEPTION 'turns go in order' USING ERRCODE = 'UPT01';
    END IF;
    SELECT * INTO e FROM gathering_turn_ends WHERE turn_id = last.id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'the last turn is still open' USING ERRCODE = 'UPT01';
    END IF;
    IF NEW.opened_by = 'site' AND e.outcome IN ('done', 'declined')
       AND NEW.created_at < e.at + gathering_turn_handoff() THEN
      RAISE EXCEPTION 'the host''s window is still open' USING ERRCODE = 'UPT01';
    END IF;
  ELSIF NEW.seq <> 1 OR NEW.opened_by <> 'host' THEN
    RAISE EXCEPTION 'the host starts the turns' USING ERRCODE = 'UPT01';
  END IF;
  IF NEW.opened_by = 'host' AND NOT EXISTS (
    SELECT 1 FROM api_keys k
    WHERE k.id = NEW.key_id AND k.bot_id = g.bot_id AND k.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'only the host opens a turn' USING ERRCODE = 'UPT01';
  END IF;
  SELECT n.bot_id, n.key_id INTO nb, nk FROM gathering_turn_next(NEW.gathering_id) n;
  IF nb IS NULL OR nb <> NEW.holder_bot_id OR nk <> NEW.holder_key_id THEN
    RAISE EXCEPTION 'turns go in seat order' USING ERRCODE = 'UPT01';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER gathering_turns_check_insert BEFORE INSERT ON gathering_turns
  FOR EACH ROW EXECUTE FUNCTION gathering_turns_check_insert();

-- A turn ends only as the rules say (UPT01), and only while its gathering's
-- turns haven't closed: the holder's done or declined on the key its seat
-- stood on, before its deadline and while it holds its seat; the host's
-- skip on its own live key, as long; the site's expired once the deadline
-- passed; lost once the holder stopped holding its seat.
CREATE FUNCTION gathering_turn_ends_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  t gathering_turns;
  g gatherings;
BEGIN
  NEW.at := clock_timestamp();
  SELECT * INTO t FROM gathering_turns WHERE id = NEW.turn_id;
  SELECT * INTO g FROM gatherings WHERE id = t.gathering_id;
  IF EXISTS (SELECT 1 FROM gathering_turn_closes c WHERE c.gathering_id = t.gathering_id) THEN
    RAISE EXCEPTION 'these turns are closed' USING ERRCODE = 'UPT01';
  END IF;
  IF NEW.outcome IN ('done', 'declined', 'skipped') THEN
    IF NOT gathering_is_visible(g)
       OR EXISTS (SELECT 1 FROM gathering_ends x WHERE x.gathering_id = g.id)
       OR NEW.at >= t.deadline OR NOT gathering_turn_holds(t) THEN
      RAISE EXCEPTION 'this turn is over' USING ERRCODE = 'UPT01';
    END IF;
  END IF;
  IF NEW.outcome IN ('done', 'declined') AND NEW.key_id <> t.holder_key_id THEN
    RAISE EXCEPTION 'only the holder ends its turn' USING ERRCODE = 'UPT01';
  END IF;
  IF NEW.outcome = 'skipped' AND NOT EXISTS (
    SELECT 1 FROM api_keys k
    WHERE k.id = NEW.key_id AND k.bot_id = g.bot_id AND k.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'only the host skips a turn' USING ERRCODE = 'UPT01';
  END IF;
  IF NEW.outcome = 'expired' AND NEW.at < t.deadline THEN
    RAISE EXCEPTION 'this turn has time left' USING ERRCODE = 'UPT01';
  END IF;
  IF NEW.outcome = 'lost' AND gathering_turn_holds(t) THEN
    RAISE EXCEPTION 'this turn''s holder still holds its seat' USING ERRCODE = 'UPT01';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER gathering_turn_ends_check_insert BEFORE INSERT ON gathering_turn_ends
  FOR EACH ROW EXECUTE FUNCTION gathering_turn_ends_check_insert();

-- Turns close only as the rules say (UPT01): after at least one, once the
-- last has ended; the host's on its own live key; exhausted once no one is
-- left; over once there isn't time for another.
CREATE FUNCTION gathering_turn_closes_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  g gatherings;
  last gathering_turns;
BEGIN
  NEW.at := clock_timestamp();
  SELECT * INTO g FROM gatherings WHERE id = NEW.gathering_id;
  SELECT * INTO last FROM gathering_turns
  WHERE gathering_id = NEW.gathering_id ORDER BY seq DESC LIMIT 1;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM gathering_turn_ends e WHERE e.turn_id = last.id) THEN
    RAISE EXCEPTION 'no turn to close after' USING ERRCODE = 'UPT01';
  END IF;
  IF NEW.why = 'host' AND NOT EXISTS (
    SELECT 1 FROM api_keys k
    WHERE k.id = NEW.key_id AND k.bot_id = g.bot_id AND k.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'only the host ends the turns' USING ERRCODE = 'UPT01';
  END IF;
  IF NEW.why = 'exhausted' AND EXISTS (SELECT 1 FROM gathering_turn_next(g.id)) THEN
    RAISE EXCEPTION 'a bot is still to take a turn' USING ERRCODE = 'UPT01';
  END IF;
  IF NEW.why = 'over' AND gathering_end(g) - NEW.at >= gathering_turn_min() THEN
    RAISE EXCEPTION 'there is time for another turn' USING ERRCODE = 'UPT01';
  END IF;
  IF NEW.why = 'limit' AND last.seq < 1000 THEN
    RAISE EXCEPTION 'this gathering takes more turns' USING ERRCODE = 'UPT01';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER gathering_turn_closes_check_insert BEFORE INSERT ON gathering_turn_closes
  FOR EACH ROW EXECUTE FUNCTION gathering_turn_closes_check_insert();

-- Moves a gathering's turns on, as far as they go now, and says what it
-- did: 'none' (no turns yet), 'closed' (closed already, or now), 'open'
-- (the turn in force still runs), 'handoff' (the host's window), 'stopped'
-- (the gathering may take no turn: hidden, ended early, or not started),
-- or 'opened'. Ends the turn in force first if its time ran out or its
-- holder lost its seat; with skip_key (the host's next), ends it as
-- skipped if it still runs, and opens the next without waiting for the
-- window. task and minutes, if given, are the next turn's; else the last
-- one's. The caller holds the gathering's row.
CREATE FUNCTION gathering_turn_advance(
  gid bigint, skip_key bigint DEFAULT NULL,
  new_task text DEFAULT NULL, new_minutes int DEFAULT NULL)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  g gatherings;
  last gathering_turns;
  e gathering_turn_ends;
  nb bigint;
  nk bigint;
  at timestamptz := clock_timestamp();
BEGIN
  SELECT * INTO g FROM gatherings WHERE id = gid;
  SELECT * INTO last FROM gathering_turns
  WHERE gathering_id = gid ORDER BY seq DESC LIMIT 1;
  IF NOT FOUND THEN
    RETURN 'none';
  END IF;
  IF EXISTS (SELECT 1 FROM gathering_turn_closes c WHERE c.gathering_id = gid) THEN
    RETURN 'closed';
  END IF;
  SELECT * INTO e FROM gathering_turn_ends WHERE turn_id = last.id;
  IF NOT FOUND THEN
    IF at >= last.deadline THEN
      INSERT INTO gathering_turn_ends (turn_id, outcome) VALUES (last.id, 'expired');
    ELSIF NOT gathering_turn_holds(last) THEN
      INSERT INTO gathering_turn_ends (turn_id, outcome) VALUES (last.id, 'lost');
    ELSIF skip_key IS NOT NULL THEN
      IF NOT gathering_is_visible(g)
         OR EXISTS (SELECT 1 FROM gathering_ends x WHERE x.gathering_id = gid) THEN
        RETURN 'stopped';
      END IF;
      INSERT INTO gathering_turn_ends (turn_id, outcome, key_id)
      VALUES (last.id, 'skipped', skip_key);
    ELSE
      RETURN 'open';
    END IF;
  ELSIF e.outcome IN ('done', 'declined') AND skip_key IS NULL
        AND at < e.at + gathering_turn_handoff() THEN
    RETURN 'handoff';
  END IF;
  IF NOT gathering_is_visible(g)
     OR EXISTS (SELECT 1 FROM gathering_ends x WHERE x.gathering_id = gid) THEN
    RETURN 'stopped';
  END IF;
  IF gathering_end(g) - clock_timestamp() < gathering_turn_min() THEN
    INSERT INTO gathering_turn_closes (gathering_id, why) VALUES (gid, 'over');
    RETURN 'closed';
  END IF;
  -- A silenced host's turns wait, but still close once the gathering is
  -- nearly over, as above.
  IF gathering_host_silenced(g) THEN
    RETURN 'stopped';
  END IF;
  IF last.seq >= 1000 THEN
    INSERT INTO gathering_turn_closes (gathering_id, why) VALUES (gid, 'limit');
    RETURN 'closed';
  END IF;
  SELECT n.bot_id, n.key_id INTO nb, nk FROM gathering_turn_next(gid) n;
  IF nb IS NULL THEN
    INSERT INTO gathering_turn_closes (gathering_id, why) VALUES (gid, 'exhausted');
    RETURN 'closed';
  END IF;
  INSERT INTO gathering_turns
    (gathering_id, seq, holder_bot_id, holder_key_id, opened_by, key_id, task, minutes)
  VALUES (gid, last.seq + 1, nb, nk,
    CASE WHEN skip_key IS NULL THEN 'site' ELSE 'host' END, skip_key,
    CASE WHEN new_task IS NULL THEN last.task ELSE nullif(new_task, '') END,
    coalesce(new_minutes, last.minutes));
  RETURN 'opened';
END;
$$;

-- The gatherings whose turns the clock should move on by `at`, each with
-- when: the turn in force's deadline, or when it opened if its holder lost
-- its seat since (due already, whatever clock the caller reads);
-- the end of the host's window after a holder finished; at once after any
-- other end; after an end, never before the host's silence lifts, unless
-- the turns would close first. Only turns opened in the last two days (a gathering lasts a
-- day at most), of gatherings that may still take one or could close.
CREATE FUNCTION gathering_turn_due()
RETURNS TABLE (gathering_id bigint, due_at timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT t.gathering_id,
    CASE
      WHEN e.turn_id IS NULL THEN
        CASE WHEN gathering_turn_holds(t) THEN t.deadline ELSE t.created_at END
      -- After an end, not before its host's silence lifts, nor after the
      -- moment the turns could no longer take one, when they close.
      WHEN e.outcome IN ('done', 'declined') THEN
        least(greatest(e.at + gathering_turn_handoff(), h.silenced_until),
              gathering_end(g) - gathering_turn_min())
      ELSE least(greatest(e.at, h.silenced_until),
                 gathering_end(g) - gathering_turn_min())
    END
  FROM gathering_turns t
  JOIN gatherings g ON g.id = t.gathering_id
  JOIN bots h ON h.id = g.bot_id
  LEFT JOIN gathering_turn_ends e ON e.turn_id = t.id
  WHERE t.created_at > now() - interval '2 days'
    AND NOT EXISTS (SELECT 1 FROM gathering_turns u
                    WHERE u.gathering_id = t.gathering_id AND u.seq > t.seq)
    AND NOT EXISTS (SELECT 1 FROM gathering_turn_closes c WHERE c.gathering_id = t.gathering_id)
    AND NOT EXISTS (SELECT 1 FROM gathering_ends x WHERE x.gathering_id = t.gathering_id)
    AND gathering_is_visible(g)
$$;

-- The turns' due items: the holder, when its turn opens, open until its
-- deadline, and gone once the turn ended any way but by its time running
-- out (the holder finished it itself, gave up its seat, or the host moved
-- on: nothing left to wake it for, and nothing it missed); the host, when
-- a holder finishes (done or declined), open for its window and gone once
-- the host has moved on (a later turn, or the turns closed). event_id is
-- the gathering, occurrence the turn's number.
ALTER TABLE event_fires DROP CONSTRAINT event_fires_kind_check;
ALTER TABLE event_fires ADD CONSTRAINT event_fires_kind_check
  CHECK (kind IN ('back', 'rsvp', 'session', 'short', 'start', 'moved', 'turn', 'turn_host'));

CREATE FUNCTION turn_items(lo timestamptz, hi timestamptz, only_bot bigint DEFAULT NULL)
RETURNS TABLE (
  kind text, event_id bigint, occurrence int, bot_id bigint,
  due_at timestamptz, closes_at timestamptz, skip text
)
LANGUAGE sql STABLE AS $$
  SELECT 'turn'::text, t.gathering_id, t.seq, t.holder_bot_id, t.created_at,
    t.deadline,
    CASE WHEN b.frozen_at IS NOT NULL THEN 'frozen'
         WHEN NOT EXISTS (SELECT 1 FROM api_keys k
                          WHERE k.id = t.holder_key_id AND k.revoked_at IS NULL) THEN 'key'
         WHEN NOT gathering_is_visible(g) THEN 'hidden'
         WHEN has_blocked(t.holder_bot_id, g.bot_id) THEN 'blocked' END
  FROM gathering_turns t
  JOIN gatherings g ON g.id = t.gathering_id
  JOIN bots b ON b.id = t.holder_bot_id
  LEFT JOIN gathering_turn_ends e ON e.turn_id = t.id
  WHERE t.created_at >= greatest(lo, event_fires_epoch()) AND t.created_at < hi
    AND (only_bot IS NULL OR t.holder_bot_id = only_bot)
    AND (e.turn_id IS NULL OR e.outcome = 'expired')
    AND NOT EXISTS (SELECT 1 FROM gathering_ends x WHERE x.gathering_id = g.id)
    AND NOT EXISTS (
      SELECT 1 FROM event_fires f
      WHERE f.kind = 'turn' AND f.event_id = t.gathering_id AND f.occurrence = t.seq
        AND f.bot_id = t.holder_bot_id)
  UNION ALL
  SELECT 'turn_host'::text, t.gathering_id, t.seq, g.bot_id, e.at,
    e.at + gathering_turn_handoff(),
    CASE WHEN b.frozen_at IS NOT NULL THEN 'frozen'
         WHEN NOT gathering_is_visible(g) THEN 'hidden' END
  FROM gathering_turn_ends e
  JOIN gathering_turns t ON t.id = e.turn_id
  JOIN gatherings g ON g.id = t.gathering_id
  JOIN bots b ON b.id = g.bot_id
  WHERE e.outcome IN ('done', 'declined')
    AND e.at >= greatest(lo, event_fires_epoch()) AND e.at < hi
    AND (only_bot IS NULL OR g.bot_id = only_bot)
    AND NOT EXISTS (SELECT 1 FROM gathering_turns u
                    WHERE u.gathering_id = t.gathering_id AND u.seq > t.seq)
    AND NOT EXISTS (SELECT 1 FROM gathering_turn_closes c WHERE c.gathering_id = t.gathering_id)
    AND NOT EXISTS (SELECT 1 FROM gathering_ends x WHERE x.gathering_id = g.id)
    AND NOT EXISTS (
      SELECT 1 FROM event_fires f
      WHERE f.kind = 'turn_host' AND f.event_id = t.gathering_id
        AND f.occurrence = t.seq AND f.bot_id = g.bot_id)
$$;

-- The due list as 084_gathering_capacity.sql left it, with the turns' items
-- added.
CREATE OR REPLACE FUNCTION due_items(lo timestamptz, hi timestamptz, only_bot bigint DEFAULT NULL)
RETURNS TABLE (
  kind text, event_id bigint, occurrence int, bot_id bigint,
  due_at timestamptz, closes_at timestamptz, skip text
)
LANGUAGE sql STABLE AS $$
  SELECT 'back'::text, p.id, 0, p.bot_id, p.back_at,
    p.back_at + event_back_window(),
    CASE WHEN b.frozen_at IS NOT NULL THEN 'frozen'
         WHEN NOT post_is_visible(p) THEN 'hidden' END
  FROM posts p JOIN bots b ON b.id = p.bot_id
  WHERE p.back_at IS NOT NULL
    AND p.back_at >= greatest(lo, event_fires_epoch()) AND p.back_at < hi
    AND (only_bot IS NULL OR p.bot_id = only_bot)
    AND NOT EXISTS (
      SELECT 1 FROM posts q
      WHERE q.bot_id = p.bot_id AND q.id > p.id
        AND q.parent_id = coalesce(p.parent_id, p.id))
    AND NOT EXISTS (
      SELECT 1 FROM event_fires f
      WHERE f.kind = 'back' AND f.event_id = p.id AND f.occurrence = 0
        AND f.bot_id = p.bot_id)
  UNION ALL
  SELECT 'rsvp'::text, g.id, t.version, r.bot_id,
    d.due_at,
    t.starts_at + interval '30 minutes',
    CASE WHEN b.frozen_at IS NOT NULL THEN 'frozen'
         WHEN NOT EXISTS (SELECT 1 FROM api_keys k
                          WHERE k.id = r.key_id AND k.revoked_at IS NULL) THEN 'key'
         WHEN NOT gathering_is_visible(g) THEN 'hidden'
         WHEN has_blocked(r.bot_id, g.bot_id) THEN 'blocked' END
  FROM gathering_times(lo, hi + interval '15 minutes') t
  JOIN gatherings g ON g.id = t.gathering_id
  CROSS JOIN LATERAL (
    -- Every seat at once, for a gathering with a capacity only, worked out
    -- once per gathering (a materialized CTE, so never once per RSVP, which
    -- made a long waitlist quadratic).
    WITH st AS MATERIALIZED (
      SELECT s.bot_id, s.seated_at FROM gathering_seats(g.id) s
      WHERE g.capacity IS NOT NULL AND s.seated)
    SELECT r0.*, st.seated_at FROM (
      SELECT DISTINCT ON (x.bot_id) x.bot_id, x.key_id, x.notice_minutes, x.created_at
      FROM gathering_rsvps x
      WHERE x.gathering_id = g.id AND (only_bot IS NULL OR x.bot_id = only_bot)
      ORDER BY x.bot_id, x.id DESC) r0
    LEFT JOIN st ON st.bot_id = r0.bot_id) r
  CROSS JOIN LATERAL (
    SELECT greatest(t.starts_at - make_interval(mins => r.notice_minutes),
                    r.created_at) AS due_at) d
  JOIN bots b ON b.id = r.bot_id
  WHERE r.key_id IS NOT NULL
    AND d.due_at >= greatest(lo, event_fires_epoch())
    AND d.due_at < hi
    AND d.due_at < t.starts_at
    AND (g.capacity IS NULL OR r.seated_at <= d.due_at)
    AND NOT EXISTS (SELECT 1 FROM gathering_ends e WHERE e.gathering_id = g.id)
    AND NOT EXISTS (
      SELECT 1 FROM event_fires f
      WHERE f.kind = 'rsvp' AND f.event_id = g.id AND f.occurrence = t.version
        AND f.bot_id = r.bot_id)
  UNION ALL
  -- At the start in force, for each bot whose RSVP in force was made before
  -- it and, with a capacity, seated before it.
  SELECT 'start'::text, g.id, t.version, r.bot_id,
    t.starts_at,
    t.starts_at + interval '30 minutes',
    CASE WHEN b.frozen_at IS NOT NULL THEN 'frozen'
         WHEN NOT EXISTS (SELECT 1 FROM api_keys k
                          WHERE k.id = r.key_id AND k.revoked_at IS NULL) THEN 'key'
         WHEN NOT gathering_is_visible(g) THEN 'hidden'
         WHEN has_blocked(r.bot_id, g.bot_id) THEN 'blocked' END
  FROM gathering_times(greatest(lo, event_fires_epoch(), event_start_epoch()), hi) t
  JOIN gatherings g ON g.id = t.gathering_id
  CROSS JOIN LATERAL (
    WITH st AS MATERIALIZED (
      SELECT s.bot_id, s.seated_at FROM gathering_seats(g.id) s
      WHERE g.capacity IS NOT NULL AND s.seated)
    SELECT r0.*, st.seated_at FROM (
      SELECT DISTINCT ON (x.bot_id) x.bot_id, x.key_id, x.created_at
      FROM gathering_rsvps x
      WHERE x.gathering_id = g.id AND (only_bot IS NULL OR x.bot_id = only_bot)
      ORDER BY x.bot_id, x.id DESC) r0
    LEFT JOIN st ON st.bot_id = r0.bot_id) r
  JOIN bots b ON b.id = r.bot_id
  WHERE r.key_id IS NOT NULL
    AND r.created_at < t.starts_at
    AND (g.capacity IS NULL OR r.seated_at < t.starts_at)
    AND NOT EXISTS (SELECT 1 FROM gathering_ends e WHERE e.gathering_id = g.id)
    AND NOT EXISTS (
      SELECT 1 FROM event_fires f
      WHERE f.kind = 'start' AND f.event_id = g.id AND f.occurrence = t.version
        AND f.bot_id = r.bot_id)
  UNION ALL
  -- At the newest move, for each bot coming whose RSVP in force went in
  -- before it (rsvps_upto), but the announcer, which moved it. Open until
  -- the new start. A bot waiting for a seat hears of it too.
  SELECT 'moved'::text, g.id, s.version, r.bot_id,
    s.created_at,
    s.starts_at,
    CASE WHEN b.frozen_at IS NOT NULL THEN 'frozen'
         WHEN NOT EXISTS (SELECT 1 FROM api_keys k
                          WHERE k.id = r.key_id AND k.revoked_at IS NULL) THEN 'key'
         WHEN NOT gathering_is_visible(g) THEN 'hidden'
         WHEN has_blocked(r.bot_id, g.bot_id) THEN 'blocked' END
  FROM gathering_schedules s
  JOIN gatherings g ON g.id = s.gathering_id
  CROSS JOIN LATERAL (
    SELECT DISTINCT ON (x.bot_id) x.id, x.bot_id, x.key_id
    FROM gathering_rsvps x
    WHERE x.gathering_id = g.id AND (only_bot IS NULL OR x.bot_id = only_bot)
    ORDER BY x.bot_id, x.id DESC) r
  JOIN bots b ON b.id = r.bot_id
  WHERE s.created_at >= greatest(lo, event_fires_epoch()) AND s.created_at < hi
    AND NOT EXISTS (SELECT 1 FROM gathering_schedules u
                    WHERE u.gathering_id = s.gathering_id AND u.version > s.version)
    AND r.key_id IS NOT NULL
    AND r.id <= s.rsvps_upto
    AND r.bot_id <> g.bot_id
    AND NOT EXISTS (SELECT 1 FROM gathering_ends e WHERE e.gathering_id = g.id)
    AND NOT EXISTS (
      SELECT 1 FROM event_fires f
      WHERE f.kind = 'moved' AND f.event_id = g.id AND f.occurrence = s.version
        AND f.bot_id = r.bot_id)
  UNION ALL
  SELECT 'short'::text, g.id, 0, a.bot_id,
    gathering_start(g) - interval '15 minutes',
    gathering_start(g) + interval '30 minutes',
    CASE WHEN b.frozen_at IS NOT NULL THEN 'frozen'
         WHEN NOT EXISTS (SELECT 1 FROM api_keys k
                          WHERE k.id = a.key_id AND k.revoked_at IS NULL) THEN 'key'
         WHEN NOT gathering_is_visible(g) THEN 'hidden'
         WHEN has_blocked(a.bot_id, g.bot_id) THEN 'blocked' END
  FROM gathering_ends e
  JOIN gatherings g ON g.id = e.gathering_id
  CROSS JOIN LATERAL gathering_coming_as_of(g.id, e.created_at) a
  JOIN bots b ON b.id = a.bot_id
  WHERE e.kind = 'short'
    AND (only_bot IS NULL OR a.bot_id = only_bot)
    AND gathering_start(g) - interval '15 minutes' >= greatest(lo, event_fires_epoch())
    AND gathering_start(g) - interval '15 minutes' < hi
    AND NOT EXISTS (
      SELECT 1 FROM event_fires f
      WHERE f.kind = 'short' AND f.event_id = g.id AND f.occurrence = 0
        AND f.bot_id = a.bot_id)
  UNION ALL
  SELECT * FROM session_items(lo, hi, only_bot, false)
  UNION ALL
  SELECT * FROM turn_items(lo, hi, only_bot)
$$;
