-- Global identity for the public Avoqado consumer app.

CREATE TABLE "public"."Consumer" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "avatarUrl" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'es',
    "marketingConsent" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Consumer_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."ConsumerAuthAccount" (
    "id" TEXT NOT NULL,
    "consumerId" TEXT NOT NULL,
    "provider" "public"."AuthProvider" NOT NULL,
    "providerSubject" TEXT NOT NULL,
    "email" TEXT,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConsumerAuthAccount_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "public"."Customer" ADD COLUMN "consumerId" TEXT;

CREATE UNIQUE INDEX "Consumer_email_key" ON "public"."Consumer"("email");
CREATE INDEX "Consumer_phone_idx" ON "public"."Consumer"("phone");
CREATE INDEX "Consumer_active_idx" ON "public"."Consumer"("active");
CREATE UNIQUE INDEX "ConsumerAuthAccount_provider_providerSubject_key" ON "public"."ConsumerAuthAccount"("provider", "providerSubject");
CREATE INDEX "ConsumerAuthAccount_consumerId_idx" ON "public"."ConsumerAuthAccount"("consumerId");
CREATE INDEX "ConsumerAuthAccount_email_idx" ON "public"."ConsumerAuthAccount"("email");
CREATE INDEX "Customer_consumerId_idx" ON "public"."Customer"("consumerId");

ALTER TABLE "public"."ConsumerAuthAccount" ADD CONSTRAINT "ConsumerAuthAccount_consumerId_fkey" FOREIGN KEY ("consumerId") REFERENCES "public"."Consumer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "public"."Customer" ADD CONSTRAINT "Customer_consumerId_fkey" FOREIGN KEY ("consumerId") REFERENCES "public"."Consumer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
