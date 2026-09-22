-- Sustitución de CFDI (TipoRelacion 04): vínculo durable factura corregida → factura original.
-- ADITIVA: columna nullable + índice. No migra datos, no toca filas existentes.
ALTER TABLE "Cfdi" ADD COLUMN IF NOT EXISTS "replacesCfdiId" TEXT;

CREATE INDEX IF NOT EXISTS "Cfdi_replacesCfdiId_idx" ON "Cfdi"("replacesCfdiId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Cfdi_replacesCfdiId_fkey') THEN
    ALTER TABLE "Cfdi" ADD CONSTRAINT "Cfdi_replacesCfdiId_fkey"
      FOREIGN KEY ("replacesCfdiId") REFERENCES "Cfdi"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
