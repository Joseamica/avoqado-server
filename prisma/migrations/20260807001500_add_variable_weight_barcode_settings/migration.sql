ALTER TABLE "VenueScaleSettings"
ADD COLUMN "variableBarcodeEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "variableBarcodePrefix" VARCHAR(2) NOT NULL DEFAULT '20';

ALTER TABLE "VenueScaleSettings"
ADD CONSTRAINT "VenueScaleSettings_variableBarcodePrefix_check"
CHECK ("variableBarcodePrefix" ~ '^[0-9]{2}$');
