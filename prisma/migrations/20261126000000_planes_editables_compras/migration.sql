-- B2 · Cada compra cita su versión. Sólo agrega: una columna opcional y una tabla nueva (vacía).

-- Columna nueva de una tabla que ya existe (opcional)
ALTER TABLE "OnboardingProgress" ADD COLUMN "planOfferVersionNumber" INTEGER;

-- CreateTable
CREATE TABLE "PlanAcceptance" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "offerVersionId" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "interval" TEXT NOT NULL,
    "quoteToken" TEXT NOT NULL,
    "validadoAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanAcceptance_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PlanAcceptance_tier_interval_check" CHECK ("tier" IN ('PRO', 'PREMIUM') AND "interval" IN ('monthly', 'annual'))
);

-- CreateIndex
CREATE INDEX "PlanAcceptance_venueId_createdAt_idx" ON "PlanAcceptance"("venueId", "createdAt");

-- AddForeignKey
ALTER TABLE "PlanAcceptance" ADD CONSTRAINT "PlanAcceptance_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanAcceptance" ADD CONSTRAINT "PlanAcceptance_offerVersionId_fkey" FOREIGN KEY ("offerVersionId") REFERENCES "PlanOfferVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
