-- Corrige un drift real entre producción y schema.prisma detectado con
-- `prisma migrate diff` el 2026-07-28.
--
-- PROD tenía RecipeLine_rawMaterialId_fkey en ON DELETE CASCADE, pero
-- schema.prisma declara la relación sin onDelete, o sea Restrict. Con CASCADE,
-- borrar una materia prima arrastraba en silencio sus líneas de receta, dejando
-- recetas incompletas y, por lo tanto, costos y descuentos de inventario mal
-- calculados sin que nadie se enterara.
--
-- Hoy no era explotable desde la app: deleteRawMaterial (rawMaterial.service.ts)
-- bloquea el borrado y devuelve la lista de recetas afectadas. Esto restaura la
-- red de seguridad a nivel de base de datos para cualquier camino futuro.
--
-- Seguro de aplicar: RecipeLine tiene 264 filas, es instantáneo.
-- El drift casi con certeza viene del mismo episodio de `migrate dev` contra
-- producción que dejó las shadow DBs huérfanas.

-- DropForeignKey
ALTER TABLE "RecipeLine" DROP CONSTRAINT "RecipeLine_rawMaterialId_fkey";

-- AddForeignKey
ALTER TABLE "RecipeLine" ADD CONSTRAINT "RecipeLine_rawMaterialId_fkey" FOREIGN KEY ("rawMaterialId") REFERENCES "RawMaterial"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
