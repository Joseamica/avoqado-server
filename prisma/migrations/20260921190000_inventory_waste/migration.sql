DO $$
BEGIN
  IF to_regtype('"WasteReportStatus"') IS NULL THEN
    CREATE TYPE "WasteReportStatus" AS ENUM ('APPLIED', 'VOIDED');
  END IF;

  IF to_regtype('"WasteItemType"') IS NULL THEN
    CREATE TYPE "WasteItemType" AS ENUM ('RAW_MATERIAL', 'PRODUCT');
  END IF;

  IF to_regtype('"WasteCostState"') IS NULL THEN
    CREATE TYPE "WasteCostState" AS ENUM ('KNOWN', 'PARTIAL', 'UNKNOWN', 'NONE');
  END IF;

  IF to_regtype('"WasteSource"') IS NULL THEN
    CREATE TYPE "WasteSource" AS ENUM ('POS', 'DASHBOARD', 'MCP');
  END IF;
END
$$;

DO $$
BEGIN
  CREATE TABLE IF NOT EXISTS "InventoryWasteReport" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "WasteReportStatus" NOT NULL,
    "payloadHash" TEXT,
    "itemType" "WasteItemType",
    "rawMaterialId" TEXT,
    "productId" TEXT,
    "unit" TEXT,
    "reasonCode" TEXT,
    "declaredQuantity" DECIMAL(12,3),
    "deductedQuantity" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "unrecordedQuantity" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "costImpact" DECIMAL(22,5),
    "costState" "WasteCostState" NOT NULL,
    "note" TEXT,
    "reference" TEXT,
    "unitCost" DECIMAL(10,2),
    "unitCostSnapshot" DECIMAL(10,2),
    "supplier" TEXT,
    "reportedByStaffId" TEXT NOT NULL,
    "source" "WasteSource" NOT NULL,
    "clientOccurredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InventoryWasteReport_pkey" PRIMARY KEY ("id")
  );

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
      VALUES
        ('InventoryWasteReport', 'InventoryWasteReport_venueId_fkey',
         'venueId', 'Venue', 'CASCADE'),
        ('InventoryWasteReport', 'InventoryWasteReport_rawMaterialId_fkey',
         'rawMaterialId', 'RawMaterial', 'CASCADE'),
        ('InventoryWasteReport', 'InventoryWasteReport_productId_fkey',
         'productId', 'Product', 'CASCADE'),
        ('InventoryWasteReport', 'InventoryWasteReport_reportedByStaffId_fkey',
         'reportedByStaffId', 'Staff', 'RESTRICT'),
        ('RawMaterialMovement', 'RawMaterialMovement_wasteReportId_fkey',
         'wasteReportId', 'InventoryWasteReport', 'NO ACTION'),
        ('InventoryMovement', 'InventoryMovement_wasteReportId_fkey',
         'wasteReportId', 'InventoryWasteReport', 'NO ACTION')
    ) AS definitions(table_name, constraint_name, column_name, referenced_table, delete_action)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = to_regclass(format('%I', relation.table_name))
        AND conname = relation.constraint_name
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I(id) ON DELETE %s ON UPDATE CASCADE',
        relation.table_name,
        relation.constraint_name,
        relation.column_name,
        relation.referenced_table,
        relation.delete_action
      );
    END IF;
  END LOOP;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"InventoryWasteReport"'::regclass
      AND conname = 'InventoryWasteReport_state_check'
  ) THEN
    ALTER TABLE "InventoryWasteReport"
      ADD CONSTRAINT "InventoryWasteReport_state_check" CHECK (
        (
          status = 'APPLIED'
          AND "payloadHash" IS NOT NULL
          AND "payloadHash" ~ '^[0-9a-f]{64}$'
          AND "itemType" IS NOT NULL
          AND unit IS NOT NULL
          AND length(unit) > 0
          AND "reasonCode" IS NOT NULL
          AND length("reasonCode") > 0
          AND "declaredQuantity" IS NOT NULL
          AND "declaredQuantity" > 0
          AND "declaredQuantity" = "deductedQuantity" + "unrecordedQuantity"
          AND (
            (
              "itemType" = 'RAW_MATERIAL'
              AND "rawMaterialId" IS NOT NULL
              AND "productId" IS NULL
              AND "unitCostSnapshot" IS NULL
            )
            OR
            (
              "itemType" = 'PRODUCT'
              AND "productId" IS NOT NULL
              AND "rawMaterialId" IS NULL
            )
          )
        )
        OR
        (
          status = 'VOIDED'
          AND "payloadHash" IS NULL
          AND "itemType" IS NULL
          AND "rawMaterialId" IS NULL
          AND "productId" IS NULL
          AND unit IS NULL
          AND "reasonCode" IS NULL
          AND "declaredQuantity" IS NULL
          AND "deductedQuantity" = 0
          AND "unrecordedQuantity" = 0
          AND "costImpact" IS NULL
          AND "costState" = 'NONE'
          AND note IS NULL
          AND reference IS NULL
          AND "unitCost" IS NULL
          AND "unitCostSnapshot" IS NULL
          AND supplier IS NULL
          AND "clientOccurredAt" IS NULL
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"InventoryWasteReport"'::regclass
      AND conname = 'InventoryWasteReport_nonnegative_check'
  ) THEN
    ALTER TABLE "InventoryWasteReport"
      ADD CONSTRAINT "InventoryWasteReport_nonnegative_check" CHECK (
        "deductedQuantity" >= 0
        AND "unrecordedQuantity" >= 0
        AND ("costImpact" IS NULL OR "costImpact" >= 0)
        AND ("unitCost" IS NULL OR "unitCost" >= 0)
        AND ("unitCostSnapshot" IS NULL OR "unitCostSnapshot" >= 0)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"InventoryWasteReport"'::regclass
      AND conname = 'InventoryWasteReport_cost_state_check'
  ) THEN
    ALTER TABLE "InventoryWasteReport"
      ADD CONSTRAINT "InventoryWasteReport_cost_state_check" CHECK (
        (
          "costState" = 'NONE'
          AND "deductedQuantity" = 0
          AND "costImpact" IS NULL
        )
        OR
        (
          "costState" = 'UNKNOWN'
          AND "deductedQuantity" > 0
          AND "costImpact" IS NULL
        )
        OR
        (
          "costState" = 'KNOWN'
          AND "deductedQuantity" > 0
          AND "unrecordedQuantity" = 0
          AND "costImpact" IS NOT NULL
        )
        OR
        (
          "costState" = 'PARTIAL'
          AND "deductedQuantity" > 0
          AND "costImpact" IS NOT NULL
        )
      );
  END IF;
END
$$;

DO $$
BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS
    "InventoryWasteReport_venueId_idempotencyKey_key"
    ON "InventoryWasteReport" ("venueId", "idempotencyKey");

  CREATE INDEX IF NOT EXISTS "InventoryWasteReport_venueId_createdAt_id_idx"
    ON "InventoryWasteReport" ("venueId", "createdAt", "id");

  CREATE INDEX IF NOT EXISTS "InventoryWasteReport_rawMaterialId_idx"
    ON "InventoryWasteReport" ("rawMaterialId");

  CREATE INDEX IF NOT EXISTS "InventoryWasteReport_productId_idx"
    ON "InventoryWasteReport" ("productId");

  CREATE INDEX IF NOT EXISTS "InventoryWasteReport_reportedByStaffId_idx"
    ON "InventoryWasteReport" ("reportedByStaffId");

  CREATE INDEX IF NOT EXISTS "RawMaterialMovement_wasteReportId_idx"
    ON "RawMaterialMovement" ("wasteReportId");

  CREATE INDEX IF NOT EXISTS "InventoryMovement_wasteReportId_idx"
    ON "InventoryMovement" ("wasteReportId");
END
$$;
