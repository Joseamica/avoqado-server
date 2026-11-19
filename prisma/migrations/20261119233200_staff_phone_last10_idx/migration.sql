-- Soporte WhatsApp: find an employee by the last 10 digits of Staff.phone, whatever format it was saved in.
-- The expression must match registeredPhone.service.ts exactly. Staff gets writes all day, so CONCURRENTLY and one
-- statement per file; if it is interrupted, DROP INDEX CONCURRENTLY the invalid copy and retry.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Staff_phone_last10_idx"
  ON "Staff" ((right(regexp_replace("phone", '\D', '', 'g'), 10)))
  WHERE "phone" IS NOT NULL;
