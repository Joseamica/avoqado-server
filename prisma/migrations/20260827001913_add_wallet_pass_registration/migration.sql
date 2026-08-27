-- CreateTable
CREATE TABLE "WalletPassRegistration" (
    "id" TEXT NOT NULL,
    "deviceLibraryIdentifier" TEXT NOT NULL,
    "walletPassId" TEXT NOT NULL,
    "pushToken" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WalletPassRegistration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WalletPassRegistration_walletPassId_idx" ON "WalletPassRegistration"("walletPassId");

-- CreateIndex
CREATE UNIQUE INDEX "WalletPassRegistration_deviceLibraryIdentifier_walletPassId_key" ON "WalletPassRegistration"("deviceLibraryIdentifier", "walletPassId");

-- AddForeignKey
ALTER TABLE "WalletPassRegistration" ADD CONSTRAINT "WalletPassRegistration_walletPassId_fkey" FOREIGN KEY ("walletPassId") REFERENCES "WalletPass"("id") ON DELETE CASCADE ON UPDATE CASCADE;
