import { Prisma } from '@prisma/client'
import type { CatalogValidationProfileResult } from '../../types/master-catalog'

const POSTGRES_INT_MAX = 2_147_483_647

interface AppliedProfileRecordV1 {
  id: string
  resourceType: string | null
  resourceId: string | null
  result: Prisma.JsonValue | null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Treats persisted APPLIED JSON as untrusted and binds it to the exact state
 * machine row before idempotent recovery may return it to a caller.
 */
export function recoverCatalogValidationProfileResultV1(record: AppliedProfileRecordV1): CatalogValidationProfileResult | null {
  const value = record.result
  if (
    record.resourceType !== 'CatalogValidationProfile' ||
    !/\S/u.test(record.id) ||
    typeof record.resourceId !== 'string' ||
    !/\S/u.test(record.resourceId) ||
    !isPlainObject(value)
  ) {
    return null
  }

  // WHY: Shape checks alone could replay JSON copied from another batch or
  // profile; both identifiers must match authoritative relational provenance.
  if (
    value.profileBatchId !== record.id ||
    value.profileId !== record.resourceId ||
    typeof value.profileVersion !== 'number' ||
    !Number.isSafeInteger(value.profileVersion) ||
    value.profileVersion < 1 ||
    value.profileVersion > POSTGRES_INT_MAX ||
    value.rulesSchemaVersion !== 1 ||
    value.active !== true
  ) {
    return null
  }
  return value as unknown as CatalogValidationProfileResult
}
