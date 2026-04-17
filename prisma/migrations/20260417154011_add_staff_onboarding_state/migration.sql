-- CreateTable
CREATE TABLE "public"."StaffOnboardingState" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "state" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffOnboardingState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StaffOnboardingState_staffId_venueId_idx" ON "public"."StaffOnboardingState"("staffId", "venueId");

-- CreateIndex
CREATE UNIQUE INDEX "StaffOnboardingState_staffId_venueId_key_key" ON "public"."StaffOnboardingState"("staffId", "venueId", "key");

-- AddForeignKey
ALTER TABLE "public"."StaffOnboardingState" ADD CONSTRAINT "StaffOnboardingState_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "public"."Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."StaffOnboardingState" ADD CONSTRAINT "StaffOnboardingState_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
