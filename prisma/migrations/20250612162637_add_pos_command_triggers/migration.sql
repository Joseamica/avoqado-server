-- Create notification function
CREATE OR REPLACE FUNCTION notify_new_command() RETURNS trigger AS $$
BEGIN
  -- Send notification with the command ID as payload
  PERFORM pg_notify('new_pos_command', json_build_object(
    'id', NEW.id,
    'venueId', NEW."venueId",
    'commandType', NEW."commandType",
    'entityType', NEW."entityType"
  )::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for INSERT
CREATE TRIGGER pos_command_insert_trigger
AFTER INSERT ON "PosCommand"
FOR EACH ROW
WHEN (NEW.status = 'PENDING')
EXECUTE FUNCTION notify_new_command();

-- Create trigger for UPDATE (when status changes to PENDING)
CREATE TRIGGER pos_command_update_trigger
AFTER UPDATE ON "PosCommand"
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'PENDING')
EXECUTE FUNCTION notify_new_command();