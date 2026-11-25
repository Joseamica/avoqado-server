-- B1 · Versiones de la oferta de planes. Sólo agrega: tablas nuevas (vacías) y dos columnas opcionales o con default.

-- CreateEnum
CREATE TYPE "PlanOfferVersionStatus" AS ENUM ('PREPARING', 'PUBLISHED', 'SUPERSEDED', 'DISCARDED');

-- CreateTable
CREATE TABLE "PlanOfferVersion" (
    "id" TEXT NOT NULL,
    "number" INTEGER,
    "status" "PlanOfferVersionStatus" NOT NULL DEFAULT 'PREPARING',
    "definition" JSONB NOT NULL,
    "basedOnVersionId" TEXT,
    "hybridPublicationIds" JSONB,
    "preparacion" JSONB,
    "createdById" TEXT NOT NULL,
    "publishedById" TEXT,
    "discardedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "discardedAt" TIMESTAMP(3),

    CONSTRAINT "PlanOfferVersion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PlanOfferVersion_number_when_published" CHECK ("status" IN ('PREPARING', 'DISCARDED') OR "number" IS NOT NULL)
);

-- CreateTable
CREATE TABLE "PlanOfferPointer" (
    "id" TEXT NOT NULL DEFAULT 'vigente',
    "currentVersionId" TEXT,
    "pendingVersionId" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "nombresEnStripe" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanOfferPointer_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PlanOfferPointer_single_row" CHECK ("id" = 'vigente')
);

-- CreateIndex
CREATE UNIQUE INDEX "PlanOfferVersion_number_key" ON "PlanOfferVersion"("number");

-- CreateIndex
CREATE INDEX "PlanOfferVersion_status_createdAt_idx" ON "PlanOfferVersion"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PlanOfferPointer_currentVersionId_key" ON "PlanOfferPointer"("currentVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "PlanOfferPointer_pendingVersionId_key" ON "PlanOfferPointer"("pendingVersionId");

-- AddForeignKey
ALTER TABLE "PlanOfferPointer" ADD CONSTRAINT "PlanOfferPointer_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "PlanOfferVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanOfferPointer" ADD CONSTRAINT "PlanOfferPointer_pendingVersionId_fkey" FOREIGN KEY ("pendingVersionId") REFERENCES "PlanOfferVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Columnas nuevas de tablas que ya existen (opcionales o con default)
ALTER TABLE "LaunchCampaignRedemption" ADD COLUMN "stripePriceId" TEXT;
ALTER TABLE "PlatformSettings" ADD COLUMN "avisosDelAltaCorreos" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
