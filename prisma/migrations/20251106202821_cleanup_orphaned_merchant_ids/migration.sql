-- Migration: Cleanup Orphaned Merchant IDs from Terminal.assignedMerchantIds
-- Date: 2025-11-06
-- Purpose: Remove any merchant IDs from Terminal.assignedMerchantIds that no longer exist in MerchantAccount table

-- Remove orphaned merchant IDs from Terminal.assignedMerchantIds
-- This cleans up IDs that were deleted directly or through data inconsistencies
UPDATE "Terminal"
SET "assignedMerchantIds" = ARRAY(
  SELECT mid
  FROM unnest("assignedMerchantIds") AS mid
  WHERE mid IN (SELECT id FROM "MerchantAccount")
)
WHERE "assignedMerchantIds" IS NOT NULL
  AND array_length("assignedMerchantIds", 1) > 0;

-- Log how many terminals were affected
DO $$
DECLARE
  affected_count INTEGER;
  orphaned_terminals RECORD;
BEGIN
  -- Count terminals with orphaned IDs
  SELECT COUNT(*) INTO affected_count
  FROM "Terminal"
  WHERE EXISTS (
    SELECT 1 FROM unnest("assignedMerchantIds") AS mid
    WHERE mid NOT IN (SELECT id FROM "MerchantAccount")
  );

  IF affected_count > 0 THEN
    RAISE NOTICE 'Found % terminal(s) with orphaned merchant IDs:', affected_count;

    -- Log details of affected terminals
    FOR orphaned_terminals IN
      SELECT
        id,
        name,
        "serialNumber",
        "assignedMerchantIds",
        ARRAY(
          SELECT mid
          FROM unnest("assignedMerchantIds") AS mid
          WHERE mid NOT IN (SELECT id FROM "MerchantAccount")
        ) AS orphaned_ids
      FROM "Terminal"
      WHERE EXISTS (
        SELECT 1 FROM unnest("assignedMerchantIds") AS mid
        WHERE mid NOT IN (SELECT id FROM "MerchantAccount")
      )
    LOOP
      RAISE NOTICE '  - Terminal: % (%) - Orphaned IDs: %',
        orphaned_terminals.name,
        orphaned_terminals."serialNumber",
        orphaned_terminals.orphaned_ids;
    END LOOP;

    RAISE NOTICE 'Cleaned orphaned merchant IDs from % terminal(s)', affected_count;
  ELSE
    RAISE NOTICE 'No orphaned merchant IDs found';
  END IF;
END $$;
