-- CRM fase 3: los mensajes del WhatsApp de ventas (coexistencia). Sólo una tabla nueva; no toca nada existente.
-- CreateTable
CREATE TABLE "CrmWhatsappMessage" (
    "id" TEXT NOT NULL,
    "wamid" TEXT NOT NULL,
    "phoneNumberId" TEXT NOT NULL,
    "contactPhone" TEXT NOT NULL,
    "contactName" TEXT,
    "direction" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "body" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL,
    "raw" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmWhatsappMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CrmWhatsappMessage_wamid_key" ON "CrmWhatsappMessage"("wamid");

-- CreateIndex
CREATE INDEX "CrmWhatsappMessage_contactPhone_sentAt_idx" ON "CrmWhatsappMessage"("contactPhone", "sentAt");

-- CreateIndex
CREATE INDEX "CrmWhatsappMessage_phoneNumberId_sentAt_idx" ON "CrmWhatsappMessage"("phoneNumberId", "sentAt");

