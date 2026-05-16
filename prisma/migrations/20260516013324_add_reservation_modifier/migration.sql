-- CreateTable
CREATE TABLE "public"."ReservationModifier" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "modifierId" TEXT,
    "name" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "price" DECIMAL(10,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReservationModifier_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReservationModifier_reservationId_idx" ON "public"."ReservationModifier"("reservationId");

-- CreateIndex
CREATE INDEX "ReservationModifier_modifierId_idx" ON "public"."ReservationModifier"("modifierId");

-- AddForeignKey
ALTER TABLE "public"."ReservationModifier" ADD CONSTRAINT "ReservationModifier_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "public"."Reservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ReservationModifier" ADD CONSTRAINT "ReservationModifier_modifierId_fkey" FOREIGN KEY ("modifierId") REFERENCES "public"."Modifier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
