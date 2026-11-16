-- A group still starts with one maker: a person (started by them) or a bot
-- (made by it). Only a claim's UPDATE (064) gives it both, so an insert that
-- names both is refused, whatever code wrote it.
CREATE FUNCTION group_channels_one_maker() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.human_id IS NOT NULL AND NEW.bot_id IS NOT NULL THEN
    RAISE EXCEPTION 'a group starts with one maker' USING ERRCODE = 'UPR01';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER group_channels_one_maker BEFORE INSERT ON group_channels
  FOR EACH ROW EXECUTE FUNCTION group_channels_one_maker();
