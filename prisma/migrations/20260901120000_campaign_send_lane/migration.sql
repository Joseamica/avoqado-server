-- Fase 1A: el carril de envío de campañas a clientes.
-- 🔴 Los enums llevan prefijo CustomerCampaign* a propósito: `CampaignStatus` ya existe en el
-- schema (módulo Marketing de superadmin, Avoqado→venues) y renombrar aquel rompería sus
-- consumidores. El que se renombra es SIEMPRE el nuevo.
CREATE TYPE "CustomerCampaignStatus" AS ENUM ('DRAFT','SCHEDULED','ENQUEUED','SENDING','SENT','CANCELLED','BLOCKED','EXPIRED');
CREATE TYPE "CustomerCampaignDeliveryStatus" AS ENUM ('PENDING','SENDING','SENT','RETRYING','DEAD','SKIPPED','UNKNOWN');
CREATE TYPE "CustomerCampaignAudience" AS ENUM ('ALL_CONSENTED','GROUP','TAGS');
CREATE TYPE "EmailSuppressionReason" AS ENUM ('HARD_BOUNCE','COMPLAINT');

CREATE TABLE "CustomerCampaign" (
  "id" TEXT NOT NULL, "venueId" TEXT NOT NULL, "name" TEXT NOT NULL,
  "status" "CustomerCampaignStatus" NOT NULL DEFAULT 'DRAFT',
  "subject" TEXT NOT NULL, "htmlBody" TEXT NOT NULL, "textBody" TEXT NOT NULL,
  "couponTemplateId" TEXT,
  "audience" "CustomerCampaignAudience" NOT NULL DEFAULT 'ALL_CONSENTED',
  "customerGroupId" TEXT, "tags" TEXT[], "scheduledFor" TIMESTAMP(3), "sendNoLaterThan" TIMESTAMP(3),
  "linkDomains" TEXT[],
  "totalRecipients" INTEGER NOT NULL DEFAULT 0, "sentCount" INTEGER NOT NULL DEFAULT 0,
  "failedCount" INTEGER NOT NULL DEFAULT 0, "skippedCount" INTEGER NOT NULL DEFAULT 0,
  "createdByStaffId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CustomerCampaign_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CustomerCampaign_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "CustomerCampaign_venueId_status_idx" ON "CustomerCampaign"("venueId","status");
CREATE INDEX "CustomerCampaign_status_scheduledFor_idx" ON "CustomerCampaign"("status","scheduledFor");

CREATE TABLE "CustomerCampaignDelivery" (
  "id" TEXT NOT NULL, "campaignId" TEXT, "automationId" TEXT,
  "customerId" TEXT NOT NULL, "venueId" TEXT NOT NULL, "dedupeKey" TEXT NOT NULL,
  "status" "CustomerCampaignDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "sendAttemptAt" TIMESTAMP(3), "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3), "leaseUntil" TIMESTAMP(3), "resendId" TEXT,
  "openedAt" TIMESTAMP(3), "clickedAt" TIMESTAMP(3), "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CustomerCampaignDelivery_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CustomerCampaignDelivery_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "CustomerCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CustomerCampaignDelivery_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  -- 🔴 XOR: exactamente uno de los dos orígenes. Sin esto caben filas con ambos nulos.
  CONSTRAINT "CustomerCampaignDelivery_origen_xor" CHECK (("campaignId" IS NOT NULL) <> ("automationId" IS NOT NULL))
);
CREATE UNIQUE INDEX "CustomerCampaignDelivery_dedupeKey_key" ON "CustomerCampaignDelivery"("dedupeKey");
CREATE INDEX "CustomerCampaignDelivery_status_nextAttemptAt_leaseUntil_idx" ON "CustomerCampaignDelivery"("status","nextAttemptAt","leaseUntil");
CREATE INDEX "CustomerCampaignDelivery_resendId_idx" ON "CustomerCampaignDelivery"("resendId");
CREATE INDEX "CustomerCampaignDelivery_campaignId_status_idx" ON "CustomerCampaignDelivery"("campaignId","status");
CREATE INDEX "CustomerCampaignDelivery_venueId_status_idx" ON "CustomerCampaignDelivery"("venueId","status");

CREATE TABLE "EmailSuppression" (
  "id" TEXT NOT NULL, "email" TEXT NOT NULL, "reason" "EmailSuppressionReason" NOT NULL,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "occurrences" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "EmailSuppression_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EmailSuppression_email_key" ON "EmailSuppression"("email");
CREATE INDEX "EmailSuppression_reason_idx" ON "EmailSuppression"("reason");

CREATE TABLE "EmailQuotaLedger" (
  "id" TEXT NOT NULL, "venueId" TEXT NOT NULL, "period" TEXT NOT NULL,
  "reserved" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EmailQuotaLedger_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EmailQuotaLedger_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "EmailQuotaLedger_venueId_period_key" ON "EmailQuotaLedger"("venueId","period");

-- Índices de AUDIENCIA sobre Customer: Prisma no expresa parcial ni GIN, van a mano.
CREATE INDEX "Customer_audiencia_consentida_idx" ON "Customer"("venueId","active") WHERE "marketingConsent" = true;
CREATE INDEX "Customer_tags_gin_idx" ON "Customer" USING GIN ("tags");
