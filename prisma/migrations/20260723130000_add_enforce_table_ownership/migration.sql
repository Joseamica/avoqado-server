-- Propiedad de mesa (PRO): "Solo el propietario puede modificar sus mesas".
-- Additive, default false = conducta histórica (cualquier staff toca cualquier mesa).
ALTER TABLE "VenueSettings" ADD COLUMN "enforceTableOwnership" BOOLEAN NOT NULL DEFAULT false;
