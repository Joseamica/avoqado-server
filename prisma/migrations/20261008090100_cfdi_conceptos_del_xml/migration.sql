-- C2 (IVA por producto, D5): lo que dice el XML timbrado —totales y cada concepto con su ObjetoImp y traslados—, evidencia para notas y extracciones.
-- ADITIVA: una columna nueva, nula. La llenan `completarArchivos` (al timbrar) y el reconciliador (las filas timbradas de antes).
ALTER TABLE "Cfdi" ADD COLUMN "xmlConceptos" JSONB;
