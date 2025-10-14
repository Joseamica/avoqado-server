/*
  Warnings:

  - You are about to drop the `MentaWebhookSubscription` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "public"."MentaWebhookSubscription" DROP CONSTRAINT "MentaWebhookSubscription_providerId_fkey";

-- DropForeignKey
ALTER TABLE "public"."MentaWebhookSubscription" DROP CONSTRAINT "MentaWebhookSubscription_venueId_fkey";

-- DropTable
DROP TABLE "public"."MentaWebhookSubscription";

-- CreateTable
CREATE TABLE "public"."WebhookSubscription" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "providerId" TEXT,
    "url" TEXT NOT NULL,
    "secretEncrypted" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WebhookSubscription_venueId_idx" ON "public"."WebhookSubscription"("venueId");

-- CreateIndex
CREATE INDEX "WebhookSubscription_providerId_idx" ON "public"."WebhookSubscription"("providerId");

-- AddForeignKey
ALTER TABLE "public"."WebhookSubscription" ADD CONSTRAINT "WebhookSubscription_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."WebhookSubscription" ADD CONSTRAINT "WebhookSubscription_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "public"."PaymentProvider"("id") ON DELETE SET NULL ON UPDATE CASCADE;
