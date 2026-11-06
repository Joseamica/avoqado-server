-- CRM C1 · lista de Clientes legible: «Usa» escrito a mano y motivo del alta sin tarjeta.
-- Todo opcional y sin FK; aditivo, las apps y el SUPERADMIN viejos no se enteran.
ALTER TABLE "public"."CrmAccount"
  ADD COLUMN "usaManual" TEXT,
  ADD COLUMN "usaManualPorque" TEXT,
  ADD COLUMN "usaManualById" TEXT,
  ADD COLUMN "usaManualAt" TIMESTAMP(3),
  ADD COLUMN "altaMotivo" TEXT,
  ADD COLUMN "altaMotivoTexto" TEXT,
  ADD COLUMN "altaPerdido" BOOLEAN NOT NULL DEFAULT false;
