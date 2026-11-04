-- CreateEnum
CREATE TYPE "ExportRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'READY', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ExportRunFormat" AS ENUM ('CSV', 'XLSX');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'EXPORT_READY';

-- CreateTable
CREATE TABLE "ExportRun" (
    "id" TEXT NOT NULL,
    "venueId" TEXT,
    "requestedById" TEXT,
    "kind" TEXT NOT NULL,
    "format" "ExportRunFormat" NOT NULL,
    "cambioACsv" BOOLEAN NOT NULL DEFAULT false,
    "params" JSONB NOT NULL,
    "columns" TEXT[],
    "huella" TEXT NOT NULL,
    "status" "ExportRunStatus" NOT NULL DEFAULT 'QUEUED',
    "esperandoCobros" BOOLEAN NOT NULL DEFAULT false,
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "processedRows" INTEGER NOT NULL DEFAULT 0,
    "corte" TIMESTAMP(3) NOT NULL,
    "filePath" TEXT,
    "fileName" TEXT,
    "fileBytes" INTEGER,
    "failureCode" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseExpiresAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "campanitaAt" TIMESTAMP(3),
    "correoAt" TIMESTAMP(3),
    "avisoIntentos" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ExportRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExportRun_status_createdAt_idx" ON "ExportRun"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ExportRun_venueId_requestedById_createdAt_idx" ON "ExportRun"("venueId", "requestedById", "createdAt");

-- CreateIndex
CREATE INDEX "ExportRun_requestedById_huella_status_idx" ON "ExportRun"("requestedById", "huella", "status");

-- AddForeignKey
ALTER TABLE "ExportRun" ADD CONSTRAINT "ExportRun_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExportRun" ADD CONSTRAINT "ExportRun_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;
