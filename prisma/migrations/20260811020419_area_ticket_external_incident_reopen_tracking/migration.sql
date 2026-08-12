-- AlterTable
ALTER TABLE "AreaTicketExternalIncident" ADD COLUMN     "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "reopenedAt" TIMESTAMP(3);

