-- Tasa del Impuesto Sobre Nómina (ISN), estatal, que paga el patrón sobre las percepciones. Default 0
-- (no configurada → no se calcula). Fracción con 4 decimales (0.0300 = 3%).
ALTER TABLE "FiscalEmisor" ADD COLUMN "isnRate" DECIMAL(5,4) NOT NULL DEFAULT 0;
