-- AlterEnum
ALTER TYPE "public"."PaymentMethod" ADD VALUE 'CRYPTOCURRENCY';

-- CreateTable
CREATE TABLE "public"."StaffPasskey" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "counter" INTEGER NOT NULL DEFAULT 0,
    "credentialType" TEXT NOT NULL DEFAULT 'public-key',
    "deviceName" TEXT,
    "deviceType" TEXT,
    "aaguid" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "StaffPasskey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StaffPasskey_credentialId_key" ON "public"."StaffPasskey"("credentialId");

-- CreateIndex
CREATE INDEX "StaffPasskey_staffId_idx" ON "public"."StaffPasskey"("staffId");

-- CreateIndex
CREATE INDEX "StaffPasskey_credentialId_idx" ON "public"."StaffPasskey"("credentialId");

-- AddForeignKey
ALTER TABLE "public"."StaffPasskey" ADD CONSTRAINT "StaffPasskey_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "public"."Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;
