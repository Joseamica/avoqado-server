-- VenueFeature.updatedAt — CAS optimista del acceso al plan.
-- Aditiva y con DEFAULT, así que las filas existentes quedan pobladas sin bloquear escrituras.
ALTER TABLE "VenueFeature" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
