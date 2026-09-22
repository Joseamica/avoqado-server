-- Merma (Ruling 29): liga el kardex con el libro de merma — la columna "wasteReportId" en
-- RawMaterialMovement e InventoryMovement y sus llaves hacia InventoryWasteReport.
--
-- Va APARTE de 20260921190000_inventory_waste a propósito. Prisma manda cada archivo como UNA transacción
-- implícita, y el ADD COLUMN toma ACCESS EXCLUSIVE sobre las dos tablas del kardex (cada venta escribe
-- ahí) hasta el COMMIT. Este archivo sólo toca el kardex y la tabla nueva, que nadie usa todavía: una vez
-- tomados los dos candados del kardex no espera ningún otro, así que la retención es la de dos cambios de
-- metadatos (una columna nullable sin default no reescribe la tabla) y dos llaves que no recorren nada.
-- Peor caso: esperar el candado de InventoryMovement (≤ 5 s, lock_timeout) con el de RawMaterialMovement
-- ya tomado.
DO $$
BEGIN
  ALTER TABLE "RawMaterialMovement"
    ADD COLUMN IF NOT EXISTS "wasteReportId" TEXT;

  ALTER TABLE "InventoryMovement"
    ADD COLUMN IF NOT EXISTS "wasteReportId" TEXT;
END
$$;

DO $$
DECLARE
  relation RECORD;
BEGIN
  FOR relation IN
    SELECT *
    FROM (
      -- Los FKs movimiento → folio van DIFERIDOS al COMMIT. El folio cae en cascada con su
      -- artículo a un nivel y el kardex del producto a dos (Product → Inventory → InventoryMovement);
      -- Postgres dispara esas cascadas en orden alfabético de trigger, que lleva el OID y en
      -- producción es impredecible. Una verificación inmediata truena si la del folio corre primero.
      -- Prisma no expresa DEFERRABLE: en el schema estas relaciones dicen sólo NoAction.
      --
      -- Y nacen NOT VALID (Ruling 27): con el kardex en ACCESS EXCLUSIVE, una FK validada recorrería las
      -- dos tablas enteras con ese candado puesto. NOT VALID no recorre: vigila desde ya toda fila nueva o
      -- cambiada y deja las viejas (todas con "wasteReportId" NULL, la columna es nueva) a
      -- 20260921190100_validate_waste_report_fks, cuyo VALIDATE CONSTRAINT toma SHARE UPDATE EXCLUSIVE y
      -- no frena escrituras.
      VALUES
        ('RawMaterialMovement', 'RawMaterialMovement_wasteReportId_fkey',
         'wasteReportId', 'InventoryWasteReport', 'NO ACTION', 'DEFERRABLE INITIALLY DEFERRED NOT VALID'),
        ('InventoryMovement', 'InventoryMovement_wasteReportId_fkey',
         'wasteReportId', 'InventoryWasteReport', 'NO ACTION', 'DEFERRABLE INITIALLY DEFERRED NOT VALID')
    ) AS definitions(table_name, constraint_name, column_name, referenced_table, delete_action, deferral)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = to_regclass(format('%I', relation.table_name))
        AND conname = relation.constraint_name
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I(id) ON DELETE %s ON UPDATE CASCADE %s',
        relation.table_name,
        relation.constraint_name,
        relation.column_name,
        relation.referenced_table,
        relation.delete_action,
        relation.deferral
      );
    END IF;
  END LOOP;
END
$$;
