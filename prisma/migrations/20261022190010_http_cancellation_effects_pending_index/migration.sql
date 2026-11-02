CREATE INDEX CONCURRENTLY IF NOT EXISTS "PosSyncIntent_cancelEffects_pending_idx" ON "PosSyncIntent" ("createdAt", id) WHERE "cancelEffectsJson" IS NOT NULL;
