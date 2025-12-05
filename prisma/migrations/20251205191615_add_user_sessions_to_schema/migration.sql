-- Ensure user_sessions table exists (created by connect-pg-simple)
-- This migration makes Prisma aware of the external table

CREATE TABLE IF NOT EXISTS "user_sessions" (
    "sid" VARCHAR NOT NULL,
    "sess" JSON NOT NULL,
    "expire" TIMESTAMP(6) NOT NULL,
    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("sid")
);

CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "user_sessions"("expire");

-- Rename constraint if it has the old name (connect-pg-simple creates it as session_pkey)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'session_pkey'
    ) THEN
        ALTER TABLE "user_sessions" RENAME CONSTRAINT "session_pkey" TO "user_sessions_pkey";
    END IF;
END $$;
