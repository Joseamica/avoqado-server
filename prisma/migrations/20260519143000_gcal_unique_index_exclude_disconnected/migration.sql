-- Fix: allow reconnecting Google Calendar after disconnect.
--
-- Phase 1 migration (20260515181302_gcal_phase1) created partial unique
-- indexes scoped only by `scope`, so a DISCONNECTED venue connection still
-- blocked a fresh CONNECTED row for the same venueId. Reconnect failed with
-- P2002 "Unique constraint failed on the fields: (`venueId`)".
--
-- Disconnect intentionally preserves history (status='DISCONNECTED' instead
-- of DELETE) for audit. Scope the partial uniqueness to non-disconnected
-- rows so we keep the audit trail AND allow reconnects.

DROP INDEX IF EXISTS "gcal_conn_venue_unique";
DROP INDEX IF EXISTS "gcal_conn_staff_unique";

CREATE UNIQUE INDEX "gcal_conn_venue_unique"
  ON "GoogleCalendarConnection"("venueId")
  WHERE "scope" = 'VENUE' AND "status" <> 'DISCONNECTED';

CREATE UNIQUE INDEX "gcal_conn_staff_unique"
  ON "GoogleCalendarConnection"("staffId")
  WHERE "scope" = 'STAFF_PERSONAL' AND "status" <> 'DISCONNECTED';
