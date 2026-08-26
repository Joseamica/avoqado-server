-- Expediente del personal.
--
-- 🔴 Datos personales sensibles (identificación, CURP, NSS, contratos). Vive detrás de su
-- propio permiso `staff-documents:*`, que sólo tienen OWNER y ADMIN por defecto.
--
-- El borrado es SUAVE (`deletedAt`): en México hay obligación de conservar ciertos
-- documentos laborales después de que la persona se va. Un borrado duro dejaría al negocio
-- sin con qué responder.

CREATE TYPE "StaffDocumentType" AS ENUM ('ID', 'CURP', 'SOCIAL_SECURITY', 'RFC', 'CONTRACT', 'CERTIFICATION', 'MEDICAL', 'OTHER');

CREATE TABLE "StaffDocument" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "type" "StaffDocumentType" NOT NULL,
    "label" TEXT,
    "fileName" TEXT NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "notes" TEXT,
    "uploadedById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StaffDocument_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "StaffDocument_staffId_deletedAt_idx" ON "StaffDocument"("staffId", "deletedAt");
CREATE INDEX "StaffDocument_venueId_deletedAt_idx" ON "StaffDocument"("venueId", "deletedAt");
-- Los avisos de vencimiento (certificados, licencias) barren por esta.
CREATE INDEX "StaffDocument_venueId_expiresAt_idx" ON "StaffDocument"("venueId", "expiresAt");

ALTER TABLE "StaffDocument" ADD CONSTRAINT "StaffDocument_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StaffDocument" ADD CONSTRAINT "StaffDocument_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- SetNull: que se vaya quien subió el documento no puede borrar el documento.
ALTER TABLE "StaffDocument" ADD CONSTRAINT "StaffDocument_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;
