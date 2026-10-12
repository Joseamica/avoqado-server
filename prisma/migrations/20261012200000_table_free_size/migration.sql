-- Plano de mesas: tamaño libre por mesa (docs/superpowers/specs/2026-10-12-plano-de-mesas-tamano-libre-design.md).
-- Normalizado a la cuadrícula de SU área (0–1), como FloorElement.width/height. NULL = automático (por forma y personas).
-- Aditiva: dos columnas nulas sin valor por omisión (sólo metadatos en Postgres; no reescribe la tabla).
ALTER TABLE "Table" ADD COLUMN "width" DOUBLE PRECISION,
ADD COLUMN "height" DOUBLE PRECISION;
