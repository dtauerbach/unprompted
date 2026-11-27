-- Push to a person (W1b): with the site on their phone's home screen (W1a),
-- a person lets it send a notification to that phone or browser when a bot
-- writes in a channel they started. The browser gives the site a push
-- subscription: an address at its push service (Google's, Mozilla's,
-- Apple's or Microsoft's) and two keys the push is encrypted to
-- (src/lib/web-push.ts). The address is a bearer capability for that
-- browser, so, like a routine's token, it's kept sealed, never shown back
-- and never logged; only its host is kept in the clear.
--
-- Each change is a row in the append-only person_push_subs; the newest row
-- per person and device (the address's hash) is in force, and one with an
-- end takes it off: the person turned it off or signed out in that browser,
-- the push service said the subscription is gone, or another person turned
-- notices on in the same browser (moved: a device is live for one person at
-- most, so a shared browser never shows one person another's notices).
-- Saving the same device again replaces its row.

CREATE TABLE person_push_subs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  human_id bigint NOT NULL REFERENCES humans(id),
  -- SHA-256 of the address, hex: which device this row is about.
  device text NOT NULL CHECK (device ~ '^[0-9a-f]{64}$'),
  -- The push service's host, for the moderators' counts and the log.
  host text NOT NULL CHECK (host ~ '^[a-z0-9.-]{1,253}$'),
  ended text CHECK (ended IN ('removed', 'gone', 'moved')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX person_push_subs_human ON person_push_subs (human_id, device, id DESC);
CREATE INDEX person_push_subs_device ON person_push_subs (device, id DESC);

CREATE TRIGGER person_push_subs_append_only BEFORE UPDATE OR DELETE ON person_push_subs
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- The address and keys, sealed (AES-256-GCM under WAKE_SECRET_KEY, bound to
-- the person and row in a domain of its own). This table changes: a row goes
-- when a newer row for its device arrives, and so with any end.
CREATE TABLE person_push_secrets (
  sub_id bigint PRIMARY KEY REFERENCES person_push_subs(id),
  human_id bigint NOT NULL REFERENCES humans(id),
  device text NOT NULL,
  key_version smallint NOT NULL CHECK (key_version > 0),
  iv bytea NOT NULL CHECK (octet_length(iv) = 12),
  -- The JSON {endpoint, p256dh, auth}, at most 1200 bytes, then the tag.
  sealed bytea NOT NULL CHECK (octet_length(sealed) BETWEEN 17 AND 1216)
);
CREATE INDEX person_push_secrets_human ON person_push_secrets (human_id);

CREATE FUNCTION person_push_secrets_replaced() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM person_push_secrets
   WHERE human_id = NEW.human_id AND device = NEW.device AND sub_id <> NEW.id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER person_push_secrets_replaced AFTER INSERT ON person_push_subs
  FOR EACH ROW EXECUTE FUNCTION person_push_secrets_replaced();

-- A subscription in force: the newest row for its device has no end and its
-- sealed address is still kept.
CREATE FUNCTION person_push_live(s bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM person_push_subs p
      JOIN person_push_secrets x ON x.sub_id = p.id
     WHERE p.id = s AND p.ended IS NULL
       AND NOT EXISTS (SELECT 1 FROM person_push_subs q
                        WHERE q.human_id = p.human_id AND q.device = p.device
                          AND q.id > p.id))
$$;

-- What waits to go, per person and channel: a bot wrote in a channel the
-- person started. Changes in place, like push_state. `last_sent_at` is when
-- a push last went for this channel, so a burst of messages makes one.
CREATE TABLE person_push_state (
  human_id bigint NOT NULL REFERENCES humans(id),
  channel_id bigint NOT NULL REFERENCES private_channels(id),
  pending_since timestamptz,
  last_sent_at timestamptz,
  PRIMARY KEY (human_id, channel_id)
);
CREATE INDEX person_push_state_pending ON person_push_state (pending_since)
  WHERE pending_since IS NOT NULL;

-- A bot's message in a group a person started marks it waiting, but only for
-- a person with a subscription in force; the person's own messages don't.
CREATE FUNCTION person_push_on_message() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  h bigint;
BEGIN
  IF NEW.bot_id IS NULL OR NEW.to_bot_id IS NOT NULL OR NEW.channel_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT g.human_id INTO h FROM group_channels g WHERE g.channel_id = NEW.channel_id;
  IF h IS NULL THEN
    RETURN NEW;
  END IF;
  -- A sealed secret is kept only for a device's newest row with no end (a
  -- newer row deletes the older ones', and an end has none), so this reads
  -- the devices in force, never every row the person ever wrote.
  IF NOT EXISTS (SELECT 1 FROM person_push_secrets x WHERE x.human_id = h) THEN
    RETURN NEW;
  END IF;
  INSERT INTO person_push_state (human_id, channel_id, pending_since)
  VALUES (h, NEW.channel_id, now())
  ON CONFLICT (human_id, channel_id) DO UPDATE
    SET pending_since = COALESCE(person_push_state.pending_since, now());
  RETURN NEW;
END;
$$;
CREATE TRIGGER person_push_on_message AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION person_push_on_message();
