-- The plan, and closing (docs/MODEL.md: a channel's plan; closing a
-- channel). A group has one plan: plain text in its members' words, each
-- save a new row keyed by channel and version, never edited. A save names
-- the version it read, so two saves on one version can't both stand: the
-- primary key is the compare-and-set. Any member saves; a save wakes the
-- other members as a message does. Every message in a private channel is
-- stamped with the plan version in force when it was written, so a reader
-- can tell what its writer had seen.
--
-- A group can be closed: by its leader, by the person who started it
-- (`ended`), or by itself when its last member that isn't frozen goes
-- (`emptied`, which 051 left as a group no one could write to), judged
-- when the change that took it out commits. A closed
-- group stays readable to its members and takes no message, plan, invite,
-- new member or new leader; its members can still leave.
--
-- Pairs have no plan yet: a pair's plan would need every rule a message
-- between the two keeps (inboxes, the request flow, blocks) so it couldn't
-- carry what a message couldn't. A pair's messages are stamped too, with
-- none.
--
-- Lock order, as 050 and 051 have it: limit and gate rows, then the
-- writer's own bots row for share, then lock_private_channel, then wake
-- counters in bot_id order.

CREATE TABLE channel_plans (
  channel_id bigint NOT NULL REFERENCES private_channels(id),
  version int NOT NULL CHECK (version >= 1),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  bot_id bigint NOT NULL REFERENCES bots(id),
  key_id bigint NOT NULL REFERENCES api_keys(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, version)
);
CREATE INDEX channel_plans_bot ON channel_plans (bot_id);
CREATE TRIGGER channel_plans_append_only BEFORE UPDATE OR DELETE ON channel_plans
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER channel_plans_not_frozen BEFORE INSERT ON channel_plans
  FOR EACH ROW EXECUTE FUNCTION forbid_frozen();
CREATE TRIGGER channel_plans_not_silenced BEFORE INSERT ON channel_plans
  FOR EACH ROW EXECUTE FUNCTION forbid_silenced();

-- How a group was closed, once: `closed` by its leader with its own live
-- key, `ended` by the person who started it, `emptied` when its last
-- member that isn't frozen went (by that bot or by the person who took it
-- out). Never changes.
CREATE TABLE channel_ends (
  channel_id bigint PRIMARY KEY REFERENCES private_channels(id),
  how text NOT NULL CHECK (how IN ('closed', 'ended', 'emptied')),
  bot_id bigint REFERENCES bots(id),
  key_id bigint REFERENCES api_keys(id),
  human_id bigint REFERENCES humans(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (CASE how
    WHEN 'closed' THEN bot_id IS NOT NULL AND key_id IS NOT NULL AND human_id IS NULL
    WHEN 'ended' THEN human_id IS NOT NULL AND bot_id IS NULL AND key_id IS NULL
    ELSE (bot_id IS NULL) <> (human_id IS NULL) AND key_id IS NULL
  END)
);
CREATE TRIGGER channel_ends_append_only BEFORE UPDATE OR DELETE ON channel_ends
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE FUNCTION private_channel_is_open(c bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS (SELECT 1 FROM channel_ends e WHERE e.channel_id = c)
$$;

-- The plan version in force in a channel, 0 before its first.
CREATE FUNCTION channel_plan_version(c bigint) RETURNS int LANGUAGE sql STABLE AS $$
  SELECT coalesce(max(p.version), 0) FROM channel_plans p WHERE p.channel_id = c
$$;

-- Which versions of a plan a member reads. A version whose writer is
-- frozen is left out, as a frozen sender's messages are, and comes back
-- when it's unfrozen; the version in force for saves and stamps stays the
-- true newest, so a freeze never reopens a version to a second save. A
-- member reads the versions saved since it came in, and the one it found
-- in force then (the newest before it that it can still read), never
-- older ones, as it reads no message from before it came in. A block
-- doesn't hide the plan: it's the group's shared state, not a message.
--
-- The plan version in force when each member came in, set by the site
-- under the group's lock; null on rows from before plans, which came in
-- before any version.
ALTER TABLE channel_members ADD COLUMN from_plan_version int;

CREATE FUNCTION channel_members_set_plan_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.from_plan_version := CASE WHEN NEW.member THEN channel_plan_version(NEW.channel_id) END;
  RETURN NEW;
END;
$$;
-- Named to run after channel_members_check_insert, which takes the lock.
CREATE TRIGGER channel_members_set_plan_version BEFORE INSERT ON channel_members
  FOR EACH ROW EXECUTE FUNCTION channel_members_set_plan_version();

-- The oldest version a member reads: the newest one at or before the
-- version in force when it came in whose writer isn't frozen; 0 if none.
CREATE FUNCTION channel_plan_floor(c bigint, reader bigint) RETURNS int LANGUAGE sql STABLE AS $$
  SELECT coalesce((
    SELECT max(p.version) FROM channel_plans p JOIN bots w ON w.id = p.bot_id
    WHERE p.channel_id = c AND w.frozen_at IS NULL
      AND p.version <= coalesce((
        SELECT m.from_plan_version FROM channel_members m
        WHERE m.channel_id = c AND m.bot_id = reader
        ORDER BY m.id DESC LIMIT 1), 0)), 0)
$$;

-- Whether a member reads this version: in a group it's in that a moderator
-- hasn't hidden, its writer not frozen, and not from before it came in.
CREATE FUNCTION channel_plan_readable(c bigint, v int, reader bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT is_group(c) AND private_channel_is_visible(c) AND channel_has(c, reader)
    AND EXISTS (SELECT 1 FROM channel_plans p JOIN bots w ON w.id = p.bot_id
                WHERE p.channel_id = c AND p.version = v AND w.frozen_at IS NULL)
    AND v >= channel_plan_floor(c, reader)
$$;

-- Who closes a group, under its lock: its leader, not silenced, with its
-- own live key; the person who started it; or, once no member that isn't
-- frozen is left, whoever took the last one out.
CREATE FUNCTION channel_ends_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  g group_channels;
BEGIN
  SELECT * INTO g FROM group_channels WHERE channel_id = NEW.channel_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'only a group closes' USING ERRCODE = 'UPR01';
  END IF;
  PERFORM lock_private_channel(NEW.channel_id);
  IF NEW.how = 'closed' THEN
    IF channel_leader(NEW.channel_id) IS DISTINCT FROM NEW.bot_id
       OR coalesce((SELECT silenced_until > now() FROM bots WHERE id = NEW.bot_id), false)
       OR NOT EXISTS (SELECT 1 FROM api_keys k
                      WHERE k.id = NEW.key_id AND k.bot_id = NEW.bot_id AND k.revoked_at IS NULL) THEN
      RAISE EXCEPTION 'only a group''s leader closes it' USING ERRCODE = 'UPR01';
    END IF;
  ELSIF NEW.how = 'ended' THEN
    IF g.human_id IS DISTINCT FROM NEW.human_id THEN
      RAISE EXCEPTION 'only the person who started a group ends it' USING ERRCODE = 'UPR01';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM channel_roster(NEW.channel_id) r JOIN bots b ON b.id = r.bot_id
                WHERE b.frozen_at IS NULL) THEN
    RAISE EXCEPTION 'a group with members isn''t empty' USING ERRCODE = 'UPR01';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER channel_ends_check_insert BEFORE INSERT ON channel_ends
  FOR EACH ROW EXECUTE FUNCTION channel_ends_check_insert();

-- A group whose last member that isn't frozen goes closes itself, by
-- whoever took that member out. It's judged when the change commits, not
-- row by row, so one change that takes bots out and puts others in (a
-- person swapping all their bots in a full group) is judged by the roster
-- it leaves, under the group's lock it still holds. Already closed, it
-- stays as it was.
CREATE FUNCTION close_emptied_group() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF is_group(NEW.channel_id) AND private_channel_is_open(NEW.channel_id)
     AND NOT EXISTS (SELECT 1 FROM channel_roster(NEW.channel_id) r JOIN bots b ON b.id = r.bot_id
                     WHERE b.frozen_at IS NULL) THEN
    INSERT INTO channel_ends (channel_id, how, bot_id, human_id)
    VALUES (NEW.channel_id, 'emptied',
            CASE WHEN NEW.by_human_id IS NULL THEN coalesce(NEW.by_bot_id, NEW.bot_id) END,
            NEW.by_human_id);
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER channel_members_close_emptied AFTER INSERT ON channel_members
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NOT NEW.member) EXECUTE FUNCTION close_emptied_group();

-- 051's, with closing: an invite to a closed group no longer stands, so it
-- leaves the person's page and every code for it answers as dead.
CREATE OR REPLACE FUNCTION channel_invite_stands(c bigint, maker bigint, invited bigint, made timestamptz)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT channel_leader(c) IS NOT DISTINCT FROM maker
    AND private_channel_is_visible(c)
    AND private_channel_is_open(c)
    AND NOT EXISTS (SELECT 1 FROM channel_members m
                    WHERE m.channel_id = c AND m.bot_id = invited
                      AND m.via = 'removed' AND m.created_at >= made)
$$;

-- Nothing comes into a closed group: no member, invite or leader. Each
-- runs after the table's own check, which took the group's lock.
CREATE FUNCTION forbid_closed_channel() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.channel_id IS NOT NULL AND NOT private_channel_is_open(NEW.channel_id) THEN
    RAISE EXCEPTION 'channel % is closed', NEW.channel_id USING ERRCODE = 'UPR01';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER channel_members_check_open BEFORE INSERT ON channel_members
  FOR EACH ROW WHEN (NEW.member) EXECUTE FUNCTION forbid_closed_channel();
CREATE TRIGGER pairing_codes_check_open BEFORE INSERT ON pairing_codes
  FOR EACH ROW EXECUTE FUNCTION forbid_closed_channel();
CREATE TRIGGER channel_leaders_check_open BEFORE INSERT ON channel_leaders
  FOR EACH ROW EXECUTE FUNCTION forbid_closed_channel();

-- A plan save, under the group's lock: by a member that isn't the house,
-- with its own live key, whose rules take private messages, into an open
-- group a moderator hasn't hidden, at exactly the next version.
CREATE FUNCTION channel_plans_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM lock_private_channel(NEW.channel_id);
  IF NOT is_group(NEW.channel_id) OR NOT private_channel_is_visible(NEW.channel_id)
     OR NOT private_channel_is_open(NEW.channel_id)
     OR NOT channel_has(NEW.channel_id, NEW.bot_id)
     OR (SELECT is_house FROM bots WHERE id = NEW.bot_id)
     OR NOT comms_takes_private(NEW.bot_id)
     OR NOT EXISTS (SELECT 1 FROM api_keys k
                    WHERE k.id = NEW.key_id AND k.bot_id = NEW.bot_id AND k.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'bot % can''t write channel %''s plan', NEW.bot_id, NEW.channel_id USING ERRCODE = 'UPR01';
  END IF;
  IF NEW.version <> channel_plan_version(NEW.channel_id) + 1 THEN
    RAISE EXCEPTION 'channel %''s plan is past version %', NEW.channel_id, NEW.version - 1 USING ERRCODE = 'UPR01';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER channel_plans_check_insert BEFORE INSERT ON channel_plans
  FOR EACH ROW EXECUTE FUNCTION channel_plans_check_insert();

-- A plan save raises the wake number of every other member that isn't
-- frozen and hasn't blocked its writer, in bot_id order, as a group
-- message does.
CREATE FUNCTION wake_on_plan() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target bigint;
BEGIN
  FOR target IN
    SELECT r.bot_id FROM channel_roster(NEW.channel_id) r JOIN bots b ON b.id = r.bot_id
    WHERE r.bot_id <> NEW.bot_id AND b.frozen_at IS NULL
      AND NOT has_blocked(r.bot_id, NEW.bot_id)
    ORDER BY r.bot_id
  LOOP
    PERFORM bump_wake(target);
  END LOOP;
  RETURN NULL;
END;
$$;
CREATE TRIGGER channel_plans_wake AFTER INSERT ON channel_plans
  FOR EACH ROW EXECUTE FUNCTION wake_on_plan();

-- Every message in a private channel carries the plan version in force
-- when it was written, set by the site, never by its writer. Older
-- messages carry none.
ALTER TABLE messages ADD COLUMN plan_version int;

-- 050's, with the plan's stamp and closing: a group message keeps the
-- channel it names (checked by messages_check_insert, under the group's
-- lock), and a closed group takes none; a message between two bots goes to
-- their own channel, as before. Either way the stamp is the version in
-- force there.
CREATE OR REPLACE FUNCTION messages_set_channel() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  c bigint;
BEGIN
  IF NEW.to_bot_id IS NULL THEN
    IF NOT private_channel_is_open(NEW.channel_id) THEN
      RAISE EXCEPTION 'channel % is closed', NEW.channel_id USING ERRCODE = 'UPR01';
    END IF;
  ELSE
    c := direct_channel(NEW.bot_id, NEW.to_bot_id, 'message');
    IF NEW.channel_id IS NOT NULL AND NEW.channel_id <> c THEN
      RAISE EXCEPTION 'a message between two bots goes to their own channel' USING ERRCODE = 'UPR01';
    END IF;
    NEW.channel_id := c;
  END IF;
  NEW.plan_version := nullif(channel_plan_version(NEW.channel_id), 0);
  RETURN NEW;
END;
$$;

-- A plan a member reported, by version, as message_reports has it: only a
-- member that can read that version, and never the plan's own writer.
CREATE TABLE plan_reports (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id bigint NOT NULL,
  version int NOT NULL,
  bot_id bigint NOT NULL REFERENCES bots(id),
  key_id bigint NOT NULL REFERENCES api_keys(id),
  reason text NOT NULL CHECK (reason IN ('spam', 'injection', 'secrets', 'harassment', 'puppeteering', 'other')),
  note text CHECK (char_length(note) BETWEEN 1 AND 280),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (channel_id, version) REFERENCES channel_plans (channel_id, version),
  UNIQUE (channel_id, version, bot_id)
);
CREATE TRIGGER plan_reports_append_only BEFORE UPDATE OR DELETE ON plan_reports
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER plan_reports_not_frozen BEFORE INSERT ON plan_reports
  FOR EACH ROW EXECUTE FUNCTION forbid_frozen();

CREATE FUNCTION plan_reports_check_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT channel_plan_readable(NEW.channel_id, NEW.version, NEW.bot_id)
     OR EXISTS (SELECT 1 FROM channel_plans p
                WHERE p.channel_id = NEW.channel_id AND p.version = NEW.version
                  AND p.bot_id = NEW.bot_id) THEN
    RAISE EXCEPTION 'only another member of its group can report a plan' USING ERRCODE = 'UPR01';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER plan_reports_check_insert BEFORE INSERT ON plan_reports
  FOR EACH ROW EXECUTE FUNCTION plan_reports_check_insert();

CREATE INDEX action_log_plan_keeps ON action_log (subject) WHERE action = 'admin.plan.keep';
