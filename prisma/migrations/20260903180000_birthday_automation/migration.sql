-- Fase 2 de campañas de correo: la felicitación automática de cumpleaños.
--
-- Escrita a mano a propósito: la base de desarrollo es COMPARTIDA entre sesiones y
-- `prisma migrate dev` puede proponer un reset. Todo el bloque es idempotente.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'BirthdayAutomationStatus') THEN
    CREATE TYPE "BirthdayAutomationStatus" AS ENUM ('ACTIVE', 'PAUSED');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "BirthdayAutomation" (
  "id"                     TEXT NOT NULL,
  "venueId"                TEXT NOT NULL,
  -- 🔴 PAUSED de fábrica: nadie empieza a mandarle correos a sus clientes por una
  -- actualización que no pidió.
  "status"                 "BirthdayAutomationStatus" NOT NULL DEFAULT 'PAUSED',
  "subject"                TEXT NOT NULL,
  "contentBlocks"          JSONB,
  "htmlBody"               TEXT NOT NULL,
  "textBody"               TEXT NOT NULL,
  "linkDomains"            TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "daysBefore"             INTEGER NOT NULL DEFAULT 7,
  -- Fecha CIVIL del venue (`YYYY-MM-DD`), no un instante: un cumpleaños ocurre un día.
  -- Guardarlo como texto es deliberado — un timestamp arrastraría una zona que aquí
  -- no significa nada y volvería el cursor sensible al cambio de horario.
  "lastEvaluatedLocalDate" TEXT,
  "createdByStaffId"       TEXT,
  "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"              TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BirthdayAutomation_pkey" PRIMARY KEY ("id")
);

-- Una automatización por venue: el switch es del negocio, no de una campaña.
CREATE UNIQUE INDEX IF NOT EXISTS "BirthdayAutomation_venueId_key" ON "BirthdayAutomation"("venueId");
-- El barrido pregunta por las ACTIVE, y sólo por ésas.
CREATE INDEX IF NOT EXISTS "BirthdayAutomation_status_idx" ON "BirthdayAutomation"("status");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BirthdayAutomation_venueId_fkey'
  ) THEN
    ALTER TABLE "BirthdayAutomation"
      ADD CONSTRAINT "BirthdayAutomation_venueId_fkey"
      FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  -- `CustomerCampaignDelivery.automationId` existía desde la fase 1A como texto suelto,
  -- para que el CHECK XOR pudiera escribirse antes de que la tabla existiera. Ahora que
  -- existe, se le pone su llave foránea de verdad.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CustomerCampaignDelivery_automationId_fkey'
  ) THEN
    ALTER TABLE "CustomerCampaignDelivery"
      ADD CONSTRAINT "CustomerCampaignDelivery_automationId_fkey"
      FOREIGN KEY ("automationId") REFERENCES "BirthdayAutomation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
