-- CreateTable
CREATE TABLE "DeliveryStoreRevocation" (
    "provider" "DeliveryProvider" NOT NULL,
    "externalLocationId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "DeliveryStoreRevocation_pkey" PRIMARY KEY ("provider","externalLocationId")
);

