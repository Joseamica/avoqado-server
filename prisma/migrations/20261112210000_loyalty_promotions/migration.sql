-- Promociones de lealtad («sello doble», «puntos dobles», «+N») y partes del sello (plan 2026-11-12-promo-de-lealtad, Task 4).
--
-- Una venta con promo puede dar varios sellos y pasar la meta de la tarjeta: cada tarjeta que toca es una PARTE (0, 1, 2…).
-- Las filas que ya existen quedan con part = 0, así que «una venta = un sello» sigue igual para la parte 0.

-- CreateEnum
CREATE TYPE "LoyaltyPromotionKind" AS ENUM ('MULTIPLY', 'ADD');

-- CreateEnum
CREATE TYPE "LoyaltyPromotionLimit" AS ENUM ('NONE', 'ONCE_PER_DAY', 'ONCE_PER_PROMOTION');

-- AlterTable
ALTER TABLE "LoyaltyTransaction" ADD COLUMN     "bonusPoints" INTEGER,
ADD COLUMN     "promotionId" TEXT;

-- AlterTable
ALTER TABLE "StampEvent" ADD COLUMN     "part" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "promotionId" TEXT;

-- CreateTable
CREATE TABLE "LoyaltyPromotion" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "LoyaltyPromotionKind" NOT NULL,
    "multiplier" INTEGER,
    "extraStamps" INTEGER,
    "extraPoints" INTEGER,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "daysOfWeek" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "timeFrom" TEXT,
    "timeUntil" TEXT,
    "productIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "categoryIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "categoryProductIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "minSpend" DECIMAL(12,2),
    "limit" "LoyaltyPromotionLimit" NOT NULL DEFAULT 'NONE',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoyaltyPromotion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoyaltyPromotionUse" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "orderId" TEXT,
    "soldAt" TIMESTAMP(3) NOT NULL,
    "stampsBonus" INTEGER NOT NULL DEFAULT 0,
    "pointsBonus" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoyaltyPromotionUse_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LoyaltyPromotion_venueId_startsAt_idx" ON "LoyaltyPromotion"("venueId", "startsAt");

-- CreateIndex
CREATE INDEX "LoyaltyPromotionUse_promotionId_customerId_soldAt_idx" ON "LoyaltyPromotionUse"("promotionId", "customerId", "soldAt");

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyPromotionUse_venueId_orderId_key" ON "LoyaltyPromotionUse"("venueId", "orderId");

-- AddForeignKey
ALTER TABLE "LoyaltyTransaction" ADD CONSTRAINT "LoyaltyTransaction_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "LoyaltyPromotion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StampEvent" ADD CONSTRAINT "StampEvent_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "LoyaltyPromotion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyPromotion" ADD CONSTRAINT "LoyaltyPromotion_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyPromotion" ADD CONSTRAINT "LoyaltyPromotion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "StaffVenue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyPromotionUse" ADD CONSTRAINT "LoyaltyPromotionUse_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyPromotionUse" ADD CONSTRAINT "LoyaltyPromotionUse_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "LoyaltyPromotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyPromotionUse" ADD CONSTRAINT "LoyaltyPromotionUse_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyPromotionUse" ADD CONSTRAINT "LoyaltyPromotionUse_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 🔴 Índices únicos parciales del sello: (venueId, orderId) → (venueId, orderId, part).
-- Siguen siendo LA garantía de «cada parte de una venta se sella una sola vez» y «una sola reversa por parte»; el chequeo en
-- código sólo evita el viaje. Mismo predicado que los originales (20260826145859 y 20260828120000).
--
-- Sin CONCURRENTLY, a propósito: el cambio va dentro de la transacción implícita del archivo, así que no hay un instante sin
-- garantía entre el DROP y el CREATE (con CONCURRENTLY irían en archivos separados y con ese hueco). StampEvent es chica:
-- el candado de escritura mientras se construyen dura milisegundos.
DROP INDEX IF EXISTS "StampEvent_venueId_orderId_earn_unique";
DROP INDEX IF EXISTS "StampEvent_venueId_orderId_reversal_unique";

CREATE UNIQUE INDEX "StampEvent_venueId_orderId_part_earn_unique"
ON "StampEvent" ("venueId", "orderId", "part")
WHERE "type" = 'EARN' AND "orderId" IS NOT NULL;

CREATE UNIQUE INDEX "StampEvent_venueId_orderId_part_reversal_unique"
ON "StampEvent" ("venueId", "orderId", "part")
WHERE "type" = 'REVERSAL' AND "orderId" IS NOT NULL;
