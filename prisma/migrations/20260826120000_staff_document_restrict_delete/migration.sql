-- El expediente NO se borra en cascada. Un borrado físico del Staff (ruta superadmin)
-- arrastraba los documentos saltándose `deletedAt`. Con RESTRICT la base rechaza borrar a
-- alguien con documentos vivos: es la última red del soft delete.
-- (auditoría Codex 2026-08-26, P1 — invariante I9)
ALTER TABLE "StaffDocument" DROP CONSTRAINT "StaffDocument_staffId_fkey";
ALTER TABLE "StaffDocument" ADD CONSTRAINT "StaffDocument_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
