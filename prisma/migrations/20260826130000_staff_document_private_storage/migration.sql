-- El expediente deja de guardar una URL pública y pasa a guardar una RUTA en el prefijo
-- privado de Storage. La tabla está vacía en todos los entornos (la sección estuvo apagada
-- desde que se detectó el hueco), así que el rename no migra datos.
-- (auditoría Codex 2026-08-26, P1: Storage público — opción B del founder)
ALTER TABLE "StaffDocument" RENAME COLUMN "fileUrl" TO "storagePath";
