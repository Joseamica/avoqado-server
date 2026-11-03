-- CRM fase 2 (correo): plantillas, campañas, cola de envío, bajas, consentimiento, Gmail del vendedor y correos de la ficha.
-- Sólo CREA (tablas, índices, llaves foráneas). Sin enums de Postgres: estados y tipos son TEXT.

-- CreateTable
CREATE TABLE "CrmEmailTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "blocks" JSONB NOT NULL,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmEmailTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmCampaign" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "templateId" TEXT,
    "subject" TEXT NOT NULL,
    "blocks" JSONB NOT NULL,
    "audience" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'BORRADOR',
    "testSentHash" TEXT,
    "total" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "enqueuedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmCampaignDelivery" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "reason" TEXT NOT NULL,
    "reasonVenueName" TEXT,
    "vars" JSONB NOT NULL,
    "accountId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDIENTE',
    "skipReason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "leaseUntil" TIMESTAMP(3),
    "sendAttemptAt" TIMESTAMP(3),
    "resendId" TEXT,
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmCampaignDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmEmailOptOut" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "actorStaffId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmEmailOptOut_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmEmailConsent" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "accountId" TEXT,
    "entryId" TEXT NOT NULL,
    "consentAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "noticeVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmEmailConsent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmGmailConnection" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "googleEmail" TEXT NOT NULL,
    "refreshTokenCiphertext" BYTEA NOT NULL,
    "scopes" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVA',
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmGmailConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmGmailAccountSeen" (
    "id" TEXT NOT NULL,
    "googleEmail" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmGmailAccountSeen_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmEmailMessage" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "contactId" TEXT,
    "staffId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "fromEmail" TEXT NOT NULL,
    "toEmail" TEXT NOT NULL,
    "clientRequestId" TEXT,
    "rfcMessageId" TEXT,
    "gmailMessageId" TEXT,
    "gmailThreadId" TEXT,
    "subject" TEXT NOT NULL,
    "snippet" TEXT,
    "status" TEXT NOT NULL,
    "lastCheckedAt" TIMESTAMP(3),
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmEmailMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CrmEmailTemplate_archivedAt_updatedAt_idx" ON "CrmEmailTemplate"("archivedAt", "updatedAt");

-- CreateIndex
CREATE INDEX "CrmCampaign_status_createdAt_idx" ON "CrmCampaign"("status", "createdAt");

-- CreateIndex
CREATE INDEX "CrmCampaignDelivery_status_nextAttemptAt_leaseUntil_idx" ON "CrmCampaignDelivery"("status", "nextAttemptAt", "leaseUntil");

-- CreateIndex
CREATE INDEX "CrmCampaignDelivery_resendId_idx" ON "CrmCampaignDelivery"("resendId");

-- CreateIndex
CREATE INDEX "CrmCampaignDelivery_campaignId_status_idx" ON "CrmCampaignDelivery"("campaignId", "status");

-- CreateIndex
CREATE INDEX "CrmCampaignDelivery_sendAttemptAt_idx" ON "CrmCampaignDelivery"("sendAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "CrmCampaignDelivery_campaignId_email_key" ON "CrmCampaignDelivery"("campaignId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "CrmEmailOptOut_email_key" ON "CrmEmailOptOut"("email");

-- CreateIndex
CREATE UNIQUE INDEX "CrmEmailConsent_email_key" ON "CrmEmailConsent"("email");

-- CreateIndex
CREATE INDEX "CrmEmailConsent_accountId_idx" ON "CrmEmailConsent"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "CrmGmailConnection_staffId_key" ON "CrmGmailConnection"("staffId");

-- CreateIndex
CREATE UNIQUE INDEX "CrmGmailAccountSeen_googleEmail_key" ON "CrmGmailAccountSeen"("googleEmail");

-- CreateIndex
CREATE UNIQUE INDEX "CrmEmailMessage_clientRequestId_key" ON "CrmEmailMessage"("clientRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "CrmEmailMessage_rfcMessageId_key" ON "CrmEmailMessage"("rfcMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "CrmEmailMessage_gmailMessageId_key" ON "CrmEmailMessage"("gmailMessageId");

-- CreateIndex
CREATE INDEX "CrmEmailMessage_gmailThreadId_idx" ON "CrmEmailMessage"("gmailThreadId");

-- CreateIndex
CREATE INDEX "CrmEmailMessage_staffId_direction_status_sentAt_idx" ON "CrmEmailMessage"("staffId", "direction", "status", "sentAt");

-- CreateIndex
CREATE INDEX "CrmEmailMessage_accountId_createdAt_idx" ON "CrmEmailMessage"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "CrmEmailMessage_contactId_idx" ON "CrmEmailMessage"("contactId");

-- AddForeignKey
ALTER TABLE "CrmCampaign" ADD CONSTRAINT "CrmCampaign_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "CrmEmailTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmCampaignDelivery" ADD CONSTRAINT "CrmCampaignDelivery_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "CrmCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmEmailConsent" ADD CONSTRAINT "CrmEmailConsent_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CrmAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmEmailMessage" ADD CONSTRAINT "CrmEmailMessage_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CrmAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmEmailMessage" ADD CONSTRAINT "CrmEmailMessage_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "CrmContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
