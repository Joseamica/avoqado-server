-- Add Acta Constitutiva document URL to venues
ALTER TABLE "Venue"
ADD COLUMN     "actaDocumentUrl" TEXT;
